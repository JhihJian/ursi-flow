import { execFile } from 'node:child_process'
import path from 'node:path'
import type { GitChangeDto, GitStatusDto, WorkspaceConfig } from './types.ts'
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

/** `## main...origin/main [ahead 1]` / `## HEAD (no branch)` / `## No commits yet on main`。 */
export function parseBranchLine(line: string | null): { branch: string | null; upstream?: string } {
  if (!line) return { branch: null }
  const body = line.slice(3)
  if (body === 'HEAD (no branch)') return { branch: null }
  const noCommits = body.match(/^No commits yet on (.+)$/)
  if (noCommits) return { branch: noCommits[1] ?? null }
  const tracked = body.match(/^(?!No commits)([^\s.]+)\.\.\.([^\s]+)(?: \[[^\]]*\])?$/)
  if (tracked) return { branch: tracked[1] ?? null, upstream: tracked[2] }
  const plain = body.match(/^[^\s]+/)
  return { branch: plain ? (plain[0] ?? null) : null }
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
  changes: GitChangeDto[]
  additions: number
  deletions: number
}

export function parseStatus(branchLine: string | null, fields: string[], numstat: string): ParsedStatus {
  const { branch, upstream } = parseBranchLine(branchLine)
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
  return { branch, upstream, changes: parseChanges(fields), additions, deletions }
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
      return { isRepo: false, root: null, branch: null, changes: [], additions: 0, deletions: 0 }
    }
    throw error
  }

  const { fields, branchLine } = splitRecords(statusOut)
  let numstat = ''
  try {
    numstat = (await runGit(workspace.root, ['diff', 'HEAD', '--numstat'])).stdout
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
    changes: mapChangesToWorkspace(path.resolve(workspace.root), toplevel, parsed.changes),
    additions: parsed.additions,
    deletions: parsed.deletions,
  }
}
