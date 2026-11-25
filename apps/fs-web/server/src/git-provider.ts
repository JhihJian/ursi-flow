import { execFile } from 'node:child_process'
import path from 'node:path'
import type { GitBranchNodeDto, GitBranchesDto, GitChangeDto, GitStatusDto, WorkspaceConfig } from './types.ts'
import { ProviderError } from './local-provider.ts'

interface RunResult {
  stdout: string
}

/** 逐段校验 git 返回的路径段，防止 porcelain 输出意外产生越界段。 */
function sanitizeSegments(segments: string[]): string[] {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw new ProviderError('git_unavailable', 503, `git 返回了非法路径段：${JSON.stringify(segment)}`)
    }
  }
  return segments
}

/**
 * Git 只读状态快照：只跑只读子命令，与用户终端的 git 操作并存。
 * 永不执行暂存、提交、推送；失败统一抛 git_unavailable，不做部分成功。
 * porcelain 输出形态以 git 2.43 实测固化（见 test/api.test.ts 的临时仓库用例）。
 */

const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  // --no-optional-locks：status 默认会刷新 index 并短暂持有 index.lock，
  // 关掉它与终端 git add/commit 并发不互踩；数组参数不经 shell。
  const fullArgs = ['--no-optional-locks', '-c', 'core.quotepath=false', ...args]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // stderr 首行才有 fatal 原因（"not a git repository" 等）；error.message 首行只是 Command failed。
          const firstLine = (stderr || error.message).split('\n').find(Boolean) ?? 'git 执行失败'
          const reason =
            error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
              ? 'git 执行超时'
              : (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? 'git 命令不存在'
                : firstLine
          reject(new ProviderError('git_unavailable', 503, reason))
          return
        }
        resolve({ stdout })
      },
    )
  })
}

/** porcelain v1 -z 的记录按 NUL 分隔；rename 记录带第二个字段（旧路径）。 */
function splitRecords(output: string): { fields: string[]; branchLine: string | null } {
  const parts = output.split('\0')
  const branchLine = parts[0]?.startsWith('## ') ? (parts.shift() ?? null) : null
  // 末尾 NUL 产生空尾段；非法输入（含换行符，来自旧 git 的 -z 兜底）直接拒绝。
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  for (const field of parts) {
    if (field.includes('\n')) {
      throw new ProviderError('git_unavailable', 503, 'porcelain 输出含换行分隔，git 版本过旧')
    }
  }
  return { fields: parts, branchLine }
}

/** `## main...origin/main [ahead 1, behind 2]` / `## HEAD (no branch)` / `## No commits yet on main`。 */
export function parseBranchLine(line: string | null): {
  branch: string | null
  upstream?: string
  ahead: number
  behind: number
} {
  if (!line) return { branch: null, ahead: 0, behind: 0 }
  const body = line.slice(3)
  if (body === 'HEAD (no branch)') return { branch: null, ahead: 0, behind: 0 }
  const noCommits = body.match(/^No commits yet on (.+)$/)
  if (noCommits) return { branch: noCommits[1] ?? null, ahead: 0, behind: 0 }
  const tracked = body.match(/^(?!No commits)([^\s.]+)\.\.\.([^\s]+)(?: \[([^\]]*)\])?$/)
  if (tracked) {
    const counts = tracked[3] ?? ''
    const ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0)
    const behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0)
    return { branch: tracked[1] ?? null, upstream: tracked[2], ahead, behind }
  }
  const plain = body.match(/^\S+/)
  return { branch: plain ? (plain[0] ?? null) : null, ahead: 0, behind: 0 }
}

/**
 * 解析变更条目。输入路径相对仓库根（toplevel）；rename 只保留新路径。
 * 实测：`R  new\0old\0`（XY 后一个空格接新路径，旧路径是独立字段）。
 */
export function parseChanges(fields: string[]): GitChangeDto[] {
  const changes: GitChangeDto[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const index = field[0] ?? ' '
    const worktree = field[1] ?? ' '
    if (field[2] !== ' ') continue
    const repoPath = field.slice(3)
    if (index === 'R' || index === 'C') i++ // 跳过紧随的旧路径字段
    // untracked 目录用 normal 模式归并为单条，porcelain 输出带尾斜杠；去斜杠后按 kind 标记。
    const isDir = index === '?' && worktree === '?' && repoPath.endsWith('/')
    const normalized = isDir ? repoPath.slice(0, -1) : repoPath
    const segments = sanitizeSegments(normalized.split('/'))
    changes.push({
      path: segments,
      index,
      worktree,
      kind: isDir ? 'dir' : 'file',
    })
  }
  return changes
}

export interface ParsedStatus {
  branch: string | null
  upstream?: string
  ahead: number
  behind: number
  changes: GitChangeDto[]
  additions: number
  deletions: number
}

export function parseStatus(branchLine: string | null, fields: string[], numstat: string): ParsedStatus {
  const parsed = parseBranchLine(branchLine)
  const { branch, upstream, ahead, behind } = parsed
  // numstat 口径为 diff HEAD（暂存 + 未暂存相对 HEAD）；untracked 不在其中，
  // 二进制行为 "-\t-\t"，不计行数。status 与 numstat 非原子，按近似快照理解。
  let additions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    if (!line) continue
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/)
    if (!match) continue
    additions += match[1] === '-' ? 0 : Number(match[1])
    deletions += match[2] === '-' ? 0 : Number(match[2])
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    changes: parseChanges(fields),
    additions,
    deletions,
  }
}

/** numstat 单行 → { path, additions, deletions }；rename 格式为 "n\tm\told => new" 或 "n\tm\tprefix{old => new}"。 */
export function parseNumstatLine(line: string): { path: string; additions: number; deletions: number } | null {
  const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
  if (!match) return null
  const raw = match[3] ?? ''
  // 去掉 rename 的 "old => new" 包装，取新路径；普通路径原样
  let path: string
  const brace = raw.match(/^([^{}]*)\{(.*) => (.*)\}(.*)$/)
  if (brace) {
    path = `${brace[1] ?? ''}${brace[3] ?? ''}${brace[4] ?? ''}`
  } else {
    const arrow = raw.match(/^(.*) => (.*)$/)
    path = arrow ? (arrow[2] ?? '') : raw
  }
  return {
    path,
    additions: match[1] === '-' ? 0 : Number(match[1]),
    deletions: match[2] === '-' ? 0 : Number(match[2]),
  }
}

/** workspace root 是仓库子目录时，过滤出 root 之内并映射为相对 root 的路径。 */
function mapChangesToWorkspace(
  workspaceRoot: string,
  repoRoot: string,
  changes: GitChangeDto[],
): GitChangeDto[] {
  const mapped: GitChangeDto[] = []
  for (const change of changes) {
    const absolute = path.resolve(repoRoot, ...change.path)
    const relative = path.relative(workspaceRoot, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    mapped.push({ ...change, path: sanitizeSegments(relative.split(path.sep)) })
  }
  return mapped
}

/** 单 workspace 的完整快照：status + numstat 两次调用拼合。 */
export async function gitStatusOf(workspace: WorkspaceConfig): Promise<GitStatusDto> {
  let statusOut: string
  let toplevel: string
  try {
    const status = await runGit(workspace.root, ['status', '--porcelain=v1', '-z', '--branch'])
    statusOut = status.stdout
    toplevel = (await runGit(workspace.root, ['rev-parse', '--show-toplevel'])).stdout.trim()
  } catch (error) {
    // root 不是仓库：rev-parse 128 / status 128，按非仓库降级而非错误。
    if (error instanceof ProviderError && /fatal|not a git repository/i.test(error.message)) {
      return { isRepo: false, root: null, branch: null, ahead: 0, behind: 0, changes: [], additions: 0, deletions: 0 }
    }
    throw error
  }

  const { fields, branchLine } = splitRecords(statusOut)
  // 行数口径与变更列表一致：只统计 workspace root 之内的文件。
  // 传 pathspec（相对 toplevel）让 git 自己过滤，避免全仓库行数混进来。
  const rootAbs = path.resolve(workspace.root)
  // pathspec 用绝对路径：git 接受仓库内绝对路径，且与 cwd 无关（cwd 是 root 或 root 子目录均可）。
  // workspace 就是仓库根时用 '.'（绝对路径 equals toplevel 时 git 也接受，但 '.' 最稳）。
  const pathspec = rootAbs === toplevel ? '.' : rootAbs
  let numstat = ''
  try {
    numstat = (await runGit(workspace.root, ['diff', 'HEAD', '--numstat', '--', pathspec])).stdout
  } catch (error) {
    // 无 HEAD（空仓库）时 diff 报 fatal，行数置 0。
    if (!(error instanceof ProviderError)) throw error
  }

  const parsed = parseStatus(branchLine, fields, numstat)
  return {
    isRepo: true,
    root: toplevel,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    changes: mapChangesToWorkspace(rootAbs, toplevel, parsed.changes),
    additions: parsed.additions,
    deletions: parsed.deletions,
  }
}

const GIT_SYNC_TIMEOUT_MS = 60_000

/**
 * 与上游同步：push / pull --ff-only。改动不可自动合并时 pull 拒绝（错误信息带冲突文件名）。
 * 与只读 status 不同，这两个命令会写仓库，与用户终端的并发操作由 git 自身的锁保护；
 * 失败不重试不回滚，错误原样返给前端展示。
 */
async function runGitSync(cwd: string, args: string[]): Promise<void> {
  const fullArgs = ['-c', 'core.quotepath=false', ...args]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      { cwd, timeout: GIT_SYNC_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const firstLine = (stderr || error.message).split('\n').find(Boolean) ?? 'git 执行失败'
        const reason =
          error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
            ? 'git 同步超时'
            : firstLine
        reject(new ProviderError('git_unavailable', 503, reason))
      },
    )
  })
}

/** 前置校验：当前分支有名字且有 upstream，否则给出明确错误。 */
async function trackedBranchOf(workspace: WorkspaceConfig): Promise<void> {
  const status = await runGit(workspace.root, ['status', '--porcelain=v1', '-z', '--branch'])
  const { branch, upstream } = parseBranchLine(splitRecords(status.stdout).branchLine)
  if (!branch) throw new ProviderError('git_unavailable', 503, 'detached HEAD 无法同步')
  if (!upstream) throw new ProviderError('git_unavailable', 503, '当前分支没有上游，无法同步')
}

/** 推送当前分支到 upstream。 */
export async function gitPushOf(workspace: WorkspaceConfig): Promise<{ ok: true }> {
  await trackedBranchOf(workspace)
  await runGitSync(workspace.root, ['push'])
  return { ok: true }
}

/** 拉取并快进当前分支；有冲突或需合并时拒绝，不产生合并提交。 */
export async function gitPullOf(workspace: WorkspaceConfig): Promise<{ ok: true }> {
  await trackedBranchOf(workspace)
  await runGitSync(workspace.root, ['pull', '--ff-only'])
  return { ok: true }
}

/** for-each-ref 一行 → 解析结果。 */
interface BranchRef {
  /** refs/heads/... 或 refs/remotes/... 去掉前缀后的短名。 */
  shortName: string
  hash: string
  upstream: string
  current: boolean
}

/** 把扁平短名列表按 "/" 组装成树；同名前缀合并为 dir 节点，同层按目录优先、名称排序。 */
function buildBranchTree(refs: BranchRef[]): GitBranchNodeDto[] {
  interface DirNode extends GitBranchNodeDto {
    kind: 'dir'
    children: GitBranchNodeDto[]
  }
  const roots: GitBranchNodeDto[] = []
  // key = 目录完整路径（'/' 连接），值 = 该目录节点
  const dirIndex = new Map<string, DirNode>()

  const ensureDir = (dirPath: string): DirNode => {
    const existing = dirIndex.get(dirPath)
    if (existing) return existing
    const slash = dirPath.lastIndexOf('/')
    const name = slash === -1 ? dirPath : dirPath.slice(slash + 1)
    const parentPath = slash === -1 ? '' : dirPath.slice(0, slash)
    const node: DirNode = { name, kind: 'dir', children: [] }
    dirIndex.set(dirPath, node)
    const siblings = parentPath === '' ? roots : ensureDir(parentPath).children
    siblings.push(node)
    return node
  }

  for (const ref of refs) {
    const slash = ref.shortName.lastIndexOf('/')
    if (slash === -1) {
      roots.push({
        name: ref.shortName,
        kind: 'branch',
        hash: ref.hash,
        current: ref.current,
        upstream: ref.upstream || undefined,
      })
      continue
    }
    const parentPath = ref.shortName.slice(0, slash)
    const leafName = ref.shortName.slice(slash + 1)
    ensureDir(parentPath).children.push({
      name: leafName,
      kind: 'branch',
      hash: ref.hash,
      current: ref.current,
      upstream: ref.upstream || undefined,
    })
  }

  const sortTree = (nodes: GitBranchNodeDto[]): GitBranchNodeDto[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.kind === 'dir' && node.children) sortTree(node.children)
    }
    return nodes
  }
  return sortTree(roots)
}

/** 分支与远端分支树：一次 for-each-ref 读本地 + 远端 ref。 */
export async function gitBranchesOf(workspace: WorkspaceConfig): Promise<GitBranchesDto> {
  let statusOut: string
  let refsOut: string
  try {
    statusOut = (await runGit(workspace.root, ['status', '--porcelain=v1', '-z', '--branch'])).stdout
    refsOut = (
      await runGit(workspace.root, [
        'for-each-ref',
        '--format=%(refname)|%(objectname:short)|%(upstream:short)|%(HEAD)',
        'refs/heads',
        'refs/remotes',
      ])
    ).stdout
  } catch (error) {
    if (error instanceof ProviderError && /fatal|not a git repository/i.test(error.message)) {
      return { isRepo: false, branch: null, locals: [], remotes: [] }
    }
    throw error
  }

  const branchLine = splitRecords(statusOut).branchLine
  const { branch } = parseBranchLine(branchLine)

  const locals: BranchRef[] = []
  const remotes: BranchRef[] = []
  for (const line of refsOut.split('\n')) {
    if (!line) continue
    const [refname, hash = '', upstream = '', headFlag = ''] = line.split('|')
    if (!refname) continue
    const ref: BranchRef = {
      shortName: refname.replace(/^refs\/(heads|remotes)\//, ''),
      hash,
      upstream,
      current: headFlag.trim() === '*',
    }
    if (refname.startsWith('refs/heads/')) locals.push(ref)
    else if (refname.startsWith('refs/remotes/')) {
      // 裸的远端 HEAD（如 origin/HEAD）不是分支，跳过
      if (!/(^|\/)HEAD$/.test(ref.shortName)) remotes.push(ref)
    }
  }

  return { isRepo: true, branch, locals: buildBranchTree(locals), remotes: buildBranchTree(remotes) }
}
