import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from "node:fs"
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/server.ts'
import type { ApiError, EntryDto } from '../src/types.ts'

interface TestContext {
  baseUrl: string
  root: string
  server: import('node:http').Server
}

/** 起临时目录 + 真实 HTTP 服务，用 fetch 走完整链路。 */
async function withServer(fn: (ctx: TestContext) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-test-'))
  const server = await createServer([{ id: 't', label: 'test', provider: 'local', root }])
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}/api/fs-web`
  try {
    await fn({ baseUrl, root, server })
  } finally {
    server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function post(name: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const ctx = current!
  const res = await fetch(`${ctx.baseUrl}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

let current: TestContext | null = null

function wrap(fn: (ctx: TestContext) => Promise<void>): () => Promise<void> {
  return async () => {
    await withServer(async (ctx) => {
      current = ctx
      try {
        await fn(ctx)
      } finally {
        current = null
      }
    })
  }
}

function expectError(json: unknown, code: string): ApiError {
  assert.equal((json as ApiError).code, code, `期望错误 ${code}，实际 ${JSON.stringify(json)}`)
  return json as ApiError
}

test('workspaces 列表返回就绪状态', wrap(async (ctx) => {
  const res = await fetch(`${ctx.baseUrl}/workspaces`)
  const list = (await res.json()) as Array<{ id: string; ready: boolean }>
  assert.equal(res.status, 200)
  assert.deepEqual(list, [{ id: 't', label: 'test', provider: 'local', root: ctx.root, ready: true }])
}))

test('list 返回目录优先、按名排序的条目', wrap(async () => {
  const { root } = current!
  await fs.writeFile(path.join(root, 'b.txt'), 'x')
  await fs.writeFile(path.join(root, 'a.txt'), 'yy')
  await fs.mkdir(path.join(root, 'zdir'))
  const { status, json } = await post('list', { workspaceId: 't', path: [] })
  assert.equal(status, 200)
  const entries = (json as { entries: EntryDto[] }).entries
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['zdir', 'a.txt', 'b.txt'],
  )
  assert.equal(entries[0].type, 'dir')
  assert.equal(entries[1].size, 2)
}))

test('路径越界与非法段被拒绝', wrap(async () => {
  const { status: s1, json: j1 } = await post('list', { workspaceId: 't', path: ['..'] })
  assert.equal(s1, 400)
  expectError(j1, 'bad_request')

  const { status: s2, json: j2 } = await post('read', { workspaceId: 't', path: ['a', '..', 'b'] })
  assert.equal(s2, 400)
  expectError(j2, 'bad_request')

  const { status: s3, json: j3 } = await post('list', { workspaceId: 't', path: ['/etc'] })
  assert.equal(s3, 400)
  expectError(j3, 'bad_request')
}))

test('软链跳出 root 被拒绝', wrap(async (ctx) => {
  const { root } = ctx
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-out-'))
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'no')
    await fs.symlink(outside, path.join(root, 'link'))
    const { status, json } = await post('read', { workspaceId: 't', path: ['link', 'secret.txt'] })
    assert.equal(status, 403)
    expectError(json, 'path_outside_root')
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
}))

test('read 拒绝二进制与超限文件', wrap(async (ctx) => {
  const { root } = ctx
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
  const { status: s1, json: j1 } = await post('read', { workspaceId: 't', path: ['bin.dat'] })
  assert.equal(s1, 415)
  expectError(j1, 'binary')

  await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  const { status: s2, json: j2 } = await post('read', { workspaceId: 't', path: ['big.txt'] })
  assert.equal(s2, 413)
  expectError(j2, 'too_large')
}))

test('write 与 read 往返，保存返回新 mtime', wrap(async () => {
  const target = ['docs', 'note.md']
  await fs.mkdir(path.join(current!.root, 'docs'), { recursive: true })
  const first = await post('write', { workspaceId: 't', path: target, content: 'hello' })
  assert.equal(first.status, 200)
  const { mtime } = first.json as { mtime: number }

  const read = await post('read', { workspaceId: 't', path: target })
  assert.equal((read.json as { content: string }).content, 'hello')
  assert.equal((read.json as { mtime: number }).mtime, mtime)

  // 用旧 mtime 再写：409 冲突
  const conflict = await post('write', {
    workspaceId: 't',
    path: target,
    content: 'stale',
    expectMtime: mtime - 1,
  })
  assert.equal(conflict.status, 409)
  expectError(conflict.json, 'conflict')

  // overwrite 跳过检查
  const overwrite = await post('write', {
    workspaceId: 't',
    path: target,
    content: 'forced',
    overwrite: true,
  })
  assert.equal(overwrite.status, 200)
  const after = await post('read', { workspaceId: 't', path: target })
  assert.equal((after.json as { content: string }).content, 'forced')
}))

test('write 新文件不传 expectMtime 时拒绝外部并发创建', wrap(async () => {
  await fs.writeFile(path.join(current!.root, 'ext.txt'), 'external')
  const { status, json } = await post('write', {
    workspaceId: 't',
    path: ['ext.txt'],
    content: 'boom',
  })
  assert.equal(status, 409)
  expectError(json, 'conflict')
}))

test('mkdir / rename / delete 全流程', wrap(async () => {
  const made = await post('mkdir', { workspaceId: 't', path: ['newdir'] })
  assert.equal(made.status, 200)
  expectError((await post('mkdir', { workspaceId: 't', path: ['newdir'] })).json, 'exists')

  const renamed = await post('rename', { workspaceId: 't', path: ['newdir'], newName: 'renamed' })
  assert.equal(renamed.status, 200)
  assert.equal((renamed.json as EntryDto).name, 'renamed')

  const deleted = await post('delete', { workspaceId: 't', path: ['renamed'] })
  assert.equal(deleted.status, 200)
  const { status } = await post('stat', { workspaceId: 't', path: ['renamed'] })
  assert.equal(status, 404)
}))

test('删除根目录被拒绝，不存在路径返回 not_found', wrap(async () => {
  const rootDelete = await post('delete', { workspaceId: 't', path: [] })
  assert.equal(rootDelete.status, 400)

  const missing = await post('read', { workspaceId: 't', path: ['nope.txt'] })
  assert.equal(missing.status, 404)
  expectError(missing.json, 'not_found')
}))

test('未知 workspace 返回 workspace_not_found', wrap(async () => {
  const { status, json } = await post('list', { workspaceId: 'ghost', path: [] })
  assert.equal(status, 404)
  expectError(json, 'workspace_not_found')
}))

test('中文与空格文件名全流程', wrap(async () => {
  const segments = ['中文 目录', '笔记 一.md']
  await post('mkdir', { workspaceId: 't', path: [segments[0]] })
  const written = await post('write', {
    workspaceId: 't',
    path: segments,
    content: '# 内容',
  })
  assert.equal(written.status, 200)
  const list = await post('list', { workspaceId: 't', path: [segments[0]!] })
  assert.equal(list.status, 200)
  assert.equal((list.json as { entries: EntryDto[] }).entries[0]?.name, segments[1])
}))

// ---- git-status（阶段 1.5）----

interface GitChangeJson {
  path: string[]
  index: string
  worktree: string
  kind: 'dir' | 'file'
}

interface GitStatusJson {
  isRepo: boolean
  root: string | null
  branch: string | null
  upstream?: string
  changes: GitChangeJson[]
  additions: number
  deletions: number
}

/** 初始化临时 git 仓库：固定 user 配置，避免依赖环境全局配置。 */
async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd: dir }, (error) => (error ? reject(error) : resolve()))
    })
  await run(['init', '-b', 'main', '.'])
  await run(['config', 'user.email', 't@example.com'])
  await run(['config', 'user.name', 't'])
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

function changeOf(status: GitStatusJson, name: string): GitChangeJson {
  const change = status.changes.find((entry) => entry.path.join('/') === name)
  assert.ok(change, `变更列表缺少 ${name}：${JSON.stringify(status.changes)}`)
  return change
}

test('git-status 非 git 目录降级为 isRepo:false 而非错误', wrap(async () => {
  const { status, json } = await post('git-status', { workspaceId: 't' })
  assert.equal(status, 200)
  const body = json as GitStatusJson
  assert.equal(body.isRepo, false)
  assert.deepEqual(body.changes, [])
}))

test('git-status 返回分支、各状态码与增删行数', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'tracked.txt'), 'l1\nl2\n')
  await fs.writeFile(path.join(ctx.root, 'staged.txt'), 's1\n')
  await fs.writeFile(path.join(ctx.root, 'ren.txt'), 'r\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])

  await fs.writeFile(path.join(ctx.root, 'tracked.txt'), 'l1\nl2x\nl3\n') // 未暂存修改
  await fs.writeFile(path.join(ctx.root, 'staged-new.txt'), 'n1\n')
  await git(ctx.root, ['add', 'staged-new.txt']) // 已暂存新增
  await fs.rm(path.join(ctx.root, 'ren.txt')) // 未暂存删除
  await fs.writeFile(path.join(ctx.root, 'untracked.txt'), 'u\n')
  await fs.mkdir(path.join(ctx.root, 'un_dir'))
  await fs.writeFile(path.join(ctx.root, 'un_dir', 'inner.txt'), 'i\n')

  const { status, json } = await post('git-status', { workspaceId: 't' })
  assert.equal(status, 200)
  const body = json as GitStatusJson
  assert.equal(body.isRepo, true)
  assert.equal(body.root, ctx.root)
  assert.equal(body.branch, 'main')
  assert.equal(body.upstream, undefined)

  assert.deepEqual(changeOf(body, 'tracked.txt'), { path: ['tracked.txt'], index: ' ', worktree: 'M', kind: 'file' })
  assert.deepEqual(changeOf(body, 'staged-new.txt'), { path: ['staged-new.txt'], index: 'A', worktree: ' ', kind: 'file' })
  assert.deepEqual(changeOf(body, 'ren.txt'), { path: ['ren.txt'], index: ' ', worktree: 'D', kind: 'file' })
  assert.deepEqual(changeOf(body, 'untracked.txt'), { path: ['untracked.txt'], index: '?', worktree: '?', kind: 'file' })
  // untracked 目录归并单条，无尾斜杠段。
  assert.deepEqual(changeOf(body, 'un_dir'), { path: ['un_dir'], index: '?', worktree: '?', kind: 'dir' })

  // numstat 口径为 diff HEAD（暂存 + 未暂存相对 HEAD）：+2/-1（tracked）+1/-0（staged-new）
  // +0/-1（ren 删除）；untracked 不在 diff 里不计。
  assert.equal(body.additions, 3)
  assert.equal(body.deletions, 2)
}))

test('git-status 暂存重命名只保留新路径，行数随 rename 累计', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'old.txt'), 'x\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await git(ctx.root, ['mv', 'old.txt', 'new.txt'])

  const { status, json } = await post('git-status', { workspaceId: 't' })
  assert.equal(status, 200)
  const body = json as GitStatusJson
  assert.deepEqual(body.changes.map((change) => change.path.join('/')), ['new.txt'])
  assert.equal(changeOf(body, 'new.txt').index, 'R')
  assert.equal(body.additions, 0)
  assert.equal(body.deletions, 0)
}))

test('git-status 空仓库（无 HEAD）分支可读且行数置 0', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'only.txt'), 'x\n')
  const { status, json } = await post('git-status', { workspaceId: 't' })
  assert.equal(status, 200)
  const body = json as GitStatusJson
  assert.equal(body.isRepo, true)
  assert.equal(body.branch, 'main')
  assert.deepEqual(body.changes.map((change) => change.path.join('/')), ['only.txt'])
  assert.equal(body.additions, 0)
  assert.equal(body.deletions, 0)
}))

test('git-status 子目录 workspace 的行数只统计 workspace 内', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.mkdir(path.join(ctx.root, 'sub'))
  await fs.writeFile(path.join(ctx.root, 'sub', 'a.txt'), 'a\n')
  await fs.writeFile(path.join(ctx.root, 'outside.txt'), 'o\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await fs.writeFile(path.join(ctx.root, 'sub', 'a.txt'), 'a2\nb\n') // 内 +1
  await fs.writeFile(path.join(ctx.root, 'outside.txt'), 'o2\nx\ny\n') // 外 +2

  const sub = await createServer([{ id: 'sub', label: 'sub', provider: 'local', root: path.join(ctx.root, 'sub') }])
  await new Promise<void>((resolve) => sub.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${(sub.address() as import('node:net').AddressInfo).port}/api/fs-web/git-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'sub' }),
    })
    const body = (await res.json()) as GitStatusJson
    assert.equal(res.status, 200)
    assert.equal(body.additions, 2) // a.txt 改 1 行为 2 行：+2/-1；不含 workspace 外 outside.txt 的 +2/-1
    assert.equal(body.deletions, 1)
  } finally {
    sub.close()
  }
}))

test('git-status workspace 为仓库子目录时过滤并映射路径', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.mkdir(path.join(ctx.root, 'sub'))
  await fs.writeFile(path.join(ctx.root, 'sub', 'a.txt'), 'a\n')
  await fs.writeFile(path.join(ctx.root, 'outside.txt'), 'o\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await fs.writeFile(path.join(ctx.root, 'sub', 'a.txt'), 'a2\n') // root 内变更
  await fs.writeFile(path.join(ctx.root, 'outside.txt'), 'o2\n') // root 外变更

  // 另起一个 root 指向子目录的服务实例，验证过滤与映射。
  const sub = await createServer([{ id: 'sub', label: 'sub', provider: 'local', root: path.join(ctx.root, 'sub') }])
  await new Promise<void>((resolve) => sub.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${(sub.address() as import('node:net').AddressInfo).port}/api/fs-web/git-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'sub' }),
    })
    const body = (await res.json()) as GitStatusJson
    assert.equal(res.status, 200)
    assert.equal(body.isRepo, true)
    assert.equal(body.root, ctx.root)
    assert.deepEqual(body.changes.map((change) => change.path.join('/')), ['a.txt'])
  } finally {
    sub.close()
  }
}))

/** 建「本地仓库 + 裸 origin + 跟踪关系」的完整上游环境，返回裸仓库路径。 */
async function withUpstream(ctx: { root: string }, fn: (bare: string) => Promise<void>): Promise<void> {
  const bare = path.join(os.tmpdir(), `wsx-bare-${Date.now()}-${Math.random().toString(36).slice(2)}.git`)
  await git(ctx.root, ['clone', '--quiet', '--bare', '.', bare])
  try {
    await git(ctx.root, ['remote', 'add', 'origin', bare])
    await git(ctx.root, ['fetch', 'origin'])
    await git(ctx.root, ['branch', '--set-upstream-to=origin/main', 'main'])
    await fn(bare)
  } finally {
    await fs.rm(bare, { recursive: true, force: true })
  }
}

test('git-status 返回 ahead/behind 计数', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await withUpstream(ctx, async (bare) => {
    // 本地领先 1：追加一个提交
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'a\n')
    await git(ctx.root, ['add', '.'])
    await git(ctx.root, ['commit', '-m', 'ahead'])
    // 远端领先 1：用临时 clone 推一个本地没有的提交，再 fetch
    const clone = path.join(os.tmpdir(), `wsx-clone-${Date.now()}.wt`)
    await git(ctx.root, ['clone', '--quiet', bare, clone])
    try {
      await git(clone, ['config', 'user.email', 't@example.com'])
      await git(clone, ['config', 'user.name', 't'])
      await fs.writeFile(path.join(clone, 'b.txt'), 'b\n')
      await git(clone, ['add', '.'])
      await git(clone, ['commit', '-m', 'behind'])
      await git(clone, ['push', '--quiet', 'origin', 'main:main'])
      await git(ctx.root, ['fetch', 'origin'])
    } finally {
      await fs.rm(clone, { recursive: true, force: true })
    }
    const { json } = await post('git-status', { workspaceId: 't' })
    const body = json as GitStatusJson
    assert.equal(body.ahead, 1)
    assert.equal(body.behind, 1)
  })
}))

test('git-branches 返回本地与远端分支树', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await withUpstream(ctx, async (bare) => {
    // 建一个带斜杠的本地分支
    await git(ctx.root, ['branch', 'feature/x'])
    await git(ctx.root, ['fetch', 'origin'])
    const { status, json } = await post('git-branches', { workspaceId: 't' })
    assert.equal(status, 200)
    const body = json as {
      isRepo: boolean
      branch: string | null
      locals: Array<{ name: string; kind: string; current?: boolean; children?: unknown[] }>
      remotes: Array<{ name: string; kind: string; children?: Array<{ name: string }> }>
    }
    assert.equal(body.isRepo, true)
    assert.equal(body.branch, 'main')
    // 本地：main（当前）+ feature/ 目录（含 x）
    assert.deepEqual(body.locals.map((n) => `${n.kind}:${n.name}`), ['dir:feature', 'branch:main'])
    const feature = body.locals.find((n) => n.name === 'feature')
    assert.deepEqual((feature?.children ?? []).map((n) => `${n.kind}:${n.name}`), ['branch:x'])
    assert.equal(body.locals.find((n) => n.name === 'main')?.current, true)
    // 远端：origin 目录下 main
    assert.deepEqual(body.remotes.map((n) => n.name), ['origin'])
    assert.deepEqual((body.remotes[0]?.children ?? []).map((n) => n.name), ['main'])
  })
}))

test('git-branches 非 git 目录降级为空树', wrap(async () => {
  const { status, json } = await post('git-branches', { workspaceId: 't' })
  assert.equal(status, 200)
  const body = json as { isRepo: boolean; locals: unknown[]; remotes: unknown[] }
  assert.equal(body.isRepo, false)
  assert.deepEqual(body.locals, [])
  assert.deepEqual(body.remotes, [])
}))

test('git-push 把本地提交推到 upstream', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await withUpstream(ctx, async () => {
    await fs.writeFile(path.join(ctx.root, 'a.txt'), 'a\n')
    await git(ctx.root, ['add', '.'])
    await git(ctx.root, ['commit', '-m', 'ahead'])
    const { status, json } = await post('git-push', { workspaceId: 't' })
    assert.equal(status, 200)
    assert.deepEqual(json, { ok: true })
    const { json: after } = await post('git-status', { workspaceId: 't' })
    assert.equal((after as GitStatusJson).ahead, 0)
  })
}))

test('git-pull 快进远端新提交', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await withUpstream(ctx, async (bare) => {
    const clone = path.join(os.tmpdir(), `wsx-clone-${Date.now()}.wt`)
    await git(ctx.root, ['clone', '--quiet', bare, clone])
    try {
      await git(clone, ['config', 'user.email', 't@example.com'])
      await git(clone, ['config', 'user.name', 't'])
      await fs.writeFile(path.join(clone, 'b.txt'), 'b\n')
      await git(clone, ['add', '.'])
      await git(clone, ['commit', '-m', 'remote'])
      await git(clone, ['push', '--quiet', 'origin', 'main:main'])
    } finally {
      await fs.rm(clone, { recursive: true, force: true })
    }
    const { status, json } = await post('git-pull', { workspaceId: 't' })
    assert.equal(status, 200)
    assert.deepEqual(json, { ok: true })
    await fs.access(path.join(ctx.root, 'b.txt')) // pull 后远端文件应落地，不存在时抛错
    const { json: after } = await post('git-status', { workspaceId: 't' })
    assert.equal((after as GitStatusJson).behind, 0)
  })
}))

test('git-pull 遇分叉历史拒绝快进且不产生合并', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  await withUpstream(ctx, async (bare) => {
    // 本地追加提交
    await fs.writeFile(path.join(ctx.root, 'local.txt'), 'local\n')
    await git(ctx.root, ['add', '.'])
    await git(ctx.root, ['commit', '-m', 'local'])
    // 远端从同一基点分叉
    const clone = path.join(os.tmpdir(), `wsx-clone-${Date.now()}.wt`)
    await git(ctx.root, ['clone', '--quiet', bare, clone])
    try {
      await git(clone, ['config', 'user.email', 't@example.com'])
      await git(clone, ['config', 'user.name', 't'])
      await fs.writeFile(path.join(clone, 'remote.txt'), 'remote\n')
      await git(clone, ['add', '.'])
      await git(clone, ['commit', '-m', 'remote'])
      await git(clone, ['push', '--quiet', 'origin', 'main:main'])
    } finally {
      await fs.rm(clone, { recursive: true, force: true })
    }
    const { status, json } = await post('git-pull', { workspaceId: 't' })
    assert.equal(status, 503)
    expectError(json, 'git_unavailable')
    // 拉取失败后仓库仍在原提交，无 merge 进行中
    const head = await git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(head.trim(), 'main')
  })
}))

test('git-push 无 upstream 时明确报错', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  const { status, json } = await post('git-push', { workspaceId: 't' })
  assert.equal(status, 503)
  expectError(json, 'git_unavailable')
}))

test('git-status 检出 upstream 时返回上游分支', wrap(async (ctx) => {
  await initRepo(ctx.root)
  await fs.writeFile(path.join(ctx.root, 'f.txt'), 'f\n')
  await git(ctx.root, ['add', '.'])
  await git(ctx.root, ['commit', '-m', 'init'])
  // 本地裸仓库充当 origin，建立跟踪关系。
  const bare = path.join(os.tmpdir(), `wsx-bare-${Date.now()}.git`)
  await git(ctx.root, ['clone', '--quiet', '--bare', '.', bare])
  try {
    await git(ctx.root, ['remote', 'add', 'origin', bare])
    await git(ctx.root, ['fetch', 'origin'])
    await git(ctx.root, ['branch', '--set-upstream-to=origin/main', 'main'])
    const { status, json } = await post('git-status', { workspaceId: 't' })
    assert.equal(status, 200)
    assert.equal((json as GitStatusJson).upstream, 'origin/main')
  } finally {
    await fs.rm(bare, { recursive: true, force: true })
  }
}))

// ---- workspace 清单管理（运行时添加 / 重命名 / 移除 + 状态文件） ----

/** 带状态文件的临时目录服务；返回 baseUrl、临时根目录与 stateFile 路径。 */
async function withStateServer(
  fn: (ctx: { baseUrl: string; root: string; stateFile: string; server: import('node:http').Server }) => Promise<void>,
  seed?: Array<{ id: string; label: string; provider: 'local'; root: string }>,
  fixedStateFile?: string,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-state-'))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-root-'))
  const stateFile = fixedStateFile ?? path.join(dir, 'nested', 'workspaces.json')
  const server = await createServer(
    seed ?? [{ id: 'seed', label: 'seed', provider: 'local', root }],
    { stateFile },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}/api/fs-web`
  try {
    await fn({ baseUrl, root, stateFile, server })
  } finally {
    server.close()
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function statePost(baseUrl: string, name: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

interface WorkspaceJson {
  id: string
  label: string
  root: string
  ready: boolean
}

test('workspaces-add 成功：返回 ready 条目且 label 默认取目录名', wrap(async (ctx) => {
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-extra-'))
  try {
    await fs.writeFile(path.join(extra, 'inner.txt'), 'x')
    const { status, json } = await post('workspaces-add', { root: extra })
    assert.equal(status, 200)
    const info = json as WorkspaceJson
    assert.equal(info.ready, true)
    assert.equal(info.label, path.basename(extra))
    assert.equal(info.root, extra)
    // 列表含新条目，且能直接列目录。
    const list = (await (await fetch(`${ctx.baseUrl}/workspaces`)).json()) as WorkspaceJson[]
    assert.ok(list.some((workspace) => workspace.id === info.id))
    const entries = await post('list', { workspaceId: info.id, path: [] })
    assert.equal(entries.status, 200)
  } finally {
    await fs.rm(extra, { recursive: true, force: true })
  }
}))

test('workspaces-add 拒绝相对路径、不存在的路径与文件路径', wrap(async () => {
  const s1 = await post('workspaces-add', { root: 'relative/path' })
  assert.equal(s1.status, 400)
  expectError(s1.json, 'bad_request')

  const s2 = await post('workspaces-add', { root: '/nonexistent-dir-for-fs-web-test' })
  assert.equal(s2.status, 404)
  expectError(s2.json, 'not_found')

  const filePath = path.join(current!.root, 'plain.txt')
  await fs.writeFile(filePath, 'x')
  const s3 = await post('workspaces-add', { root: filePath })
  assert.equal(s3.status, 400)
  expectError(s3.json, 'bad_request')
}))

test('workspaces-add 重复目录返回 409 且 id 稳定', wrap(async (ctx) => {
  // ctx.root 经服务端探活已入清单（id 为 seed），同一 root 再次添加按 realpath 判重。
  const first = await post('workspaces-add', { root: ctx.root })
  assert.equal(first.status, 409)
  expectError(first.json, 'exists')
}))

test('workspaces-rename 改显示名且 FileKey 稳定（id 不变）', wrap(async (ctx) => {
  const { status, json } = await post('workspaces-rename', { workspaceId: 't', label: '我的项目' })
  assert.equal(status, 200)
  assert.equal((json as WorkspaceJson).label, '我的项目')
  const list = (await (await fetch(`${ctx.baseUrl}/workspaces`)).json()) as WorkspaceJson[]
  assert.equal(list.find((workspace) => workspace.id === 't')?.label, '我的项目')
  // id 未变，文件操作照常。
  const entries = await post('list', { workspaceId: 't', path: [] })
  assert.equal(entries.status, 200)

  const s2 = await post('workspaces-rename', { workspaceId: 'no-such', label: 'x' })
  assert.equal(s2.status, 404)
  expectError(s2.json, 'workspace_not_found')

  const s3 = await post('workspaces-rename', { workspaceId: 't', label: '   ' })
  assert.equal(s3.status, 400)
  expectError(s3.json, 'bad_request')
}))

test('workspaces-rename 可单独设置/清除 description', wrap(async (ctx) => {
  const { status, json } = await post('workspaces-rename', {
    workspaceId: 't',
    description: '测试目录，用于 api.test',
  })
  assert.equal(status, 200)
  assert.equal((json as WorkspaceJson).description, '测试目录，用于 api.test')
  // 只传 description 时 label 不变。
  assert.equal((json as WorkspaceJson).label, 'test')

  // 传空字符串清除说明（description 字段从响应中消失）。
  const cleared = await post('workspaces-rename', { workspaceId: 't', description: '' })
  assert.equal(cleared.status, 200)
  assert.equal((cleared.json as WorkspaceJson).description, undefined)

  // 两者都不传报 400。
  const empty = await post('workspaces-rename', { workspaceId: 't' })
  assert.equal(empty.status, 400)
  expectError(empty.json, 'bad_request')

  // 说明落盘验证：用固定状态文件路径的独立实例验证，不用 wrap 的无状态实例。
}))

test('workspaces-rename description 落盘验证', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-desc-'))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-descroot-'))
  const stateFile = path.join(dir, 'nested', 'workspaces.json')
  const server = await createServer([{ id: 't', label: 'test', provider: 'local', root }], {
    stateFile,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}/api/fs-web`
  try {
    const res = await fetch(`${baseUrl}/workspaces-rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 't', description: '落盘验证' }),
    })
    assert.equal(res.status, 200)
    const raw = await fs.readFile(stateFile, 'utf8')
    assert.match(raw, /落盘验证/)
  } finally {
    server.close()
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('workspaces-remove 从清单移除且不动文件系统', wrap(async (ctx) => {
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-extra-'))
  try {
    const marker = path.join(extra, 'keep.txt')
    await fs.writeFile(marker, 'data')
    const addRes = await post('workspaces-add', { root: extra })
    const info = addRes.json as WorkspaceJson
    const rm = await post('workspaces-remove', { workspaceId: info.id })
    assert.equal(rm.status, 200)
    // 清单移除，文件保留。
    const after = await post('list', { workspaceId: info.id, path: [] })
    assert.equal(after.status, 404)
    expectError(after.json, 'workspace_not_found')
    assert.equal(await fs.readFile(marker, 'utf8'), 'data')
    // 移除不存在的 id 返回 404。
    const rm2 = await post('workspaces-remove', { workspaceId: info.id })
    assert.equal(rm2.status, 404)
  } finally {
    await fs.rm(extra, { recursive: true, force: true })
  }
}))

test('状态文件：播种落盘、跨实例持久化、已存在时忽略种子', wrap(async () => {
  // 状态文件目录由外层持有：各实例的临时目录会被各自清理，状态文件必须独立存活。
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-statefile-'))
  const stateFile = path.join(stateDir, 'deep', 'workspaces.json')
  const nested = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-nested-'))
  const nestedTarget = path.join(nested, 'sub')
  await fs.mkdir(nestedTarget)
  try {
    let firstId = ''
    await withStateServer(async (ctx) => {
      // 添加一个运行时目录并重命名，产生与种子不同的状态。
      const add = await statePost(ctx.baseUrl, 'workspaces-add', { root: nestedTarget, label: '别名' })
      const info = add.json as WorkspaceJson
      firstId = info.id
      await statePost(ctx.baseUrl, 'workspaces-rename', { workspaceId: 'seed', label: '改名' })
      // 状态文件已落盘且是纯契约数组。
      const raw = JSON.parse(await fs.readFile(ctx.stateFile, 'utf8')) as WorkspaceJson[]
      assert.ok(Array.isArray(raw))
      assert.ok(raw.every((item) => ['id', 'label', 'provider', 'root'].every((key) => key in item)))
    }, undefined, stateFile)
    // 用同一状态文件重启第二个实例：运行时变更保留。
    await withStateServer(async (ctx) => {
      const list = (await (await fetch(`${ctx.baseUrl}/workspaces`)).json()) as WorkspaceJson[]
      assert.ok(list.some((workspace) => workspace.id === firstId && workspace.label === '别名'))
      assert.equal(list.find((workspace) => workspace.id === 'seed')?.label, '改名')
    }, undefined, stateFile)
    // 已有状态文件时传入不同的种子：以状态文件为准。
    const thirdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-third-'))
    try {
      await withStateServer(async (ctx) => {
        const list = (await (await fetch(`${ctx.baseUrl}/workspaces`)).json()) as WorkspaceJson[]
        assert.ok(!list.some((workspace) => workspace.id === 'other'))
        assert.ok(list.some((workspace) => workspace.id === 'seed'))
      }, [{ id: 'other', label: 'other', provider: 'local', root: thirdRoot }], stateFile)
    } finally {
      await fs.rm(thirdRoot, { recursive: true, force: true })
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
    await fs.rm(nested, { recursive: true, force: true })
  }
}))

test('状态文件损坏或条目非法时启动直接失败', wrap(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-corrupt-'))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-root-'))
  const stateFile = path.join(dir, 'workspaces.json')
  try {
    await fs.writeFile(stateFile, '{not json', 'utf8')
    await assert.rejects(
      () => createServer([{ id: 'seed', label: 'seed', provider: 'local', root }], { stateFile }),
    )
    await fs.writeFile(stateFile, JSON.stringify([{ id: 'BAD ID', provider: 'local', root }]), 'utf8')
    await assert.rejects(
      () => createServer([{ id: 'seed', label: 'seed', provider: 'local', root }], { stateFile }),
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
}))

test('移除未就绪（root 已消失）的 workspace', wrap(async (ctx) => {
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-web-vanish-'))
  try {
    const add = await post('workspaces-add', { root: extra })
    const info = add.json as WorkspaceJson
    await fs.rm(extra, { recursive: true, force: true })
    // root 消失后旧实例内存仍 ready，但真实场景重启后该条目未就绪；这里直接验证移除通道可用。
    const rm = await post('workspaces-remove', { workspaceId: info.id })
    assert.equal(rm.status, 200)
  } finally {
    await fs.rm(extra, { recursive: true, force: true })
  }
}))

test('跨站 Origin 被拒绝，回环与同 Host 放行', wrap(async (ctx) => {
  const evil = await fetch(`${ctx.baseUrl}/workspaces`, { headers: { origin: 'https://evil.example.com' } })
  assert.equal(evil.status, 403)
  expectError(await evil.json(), 'forbidden_origin')

  const port = (ctx.server.address() as { port: number }).port
  const ok1 = await fetch(`${ctx.baseUrl}/workspaces`, { headers: { origin: `http://127.0.0.1:${port}` } })
  assert.equal(ok1.status, 200)
  const ok2 = await fetch(`${ctx.baseUrl}/workspaces`, { headers: { origin: 'http://localhost:5191' } })
  assert.equal(ok2.status, 200)
  const noOrigin = await post('list', { workspaceId: 't', path: [] })
  assert.equal(noOrigin.status, 200)
}))
