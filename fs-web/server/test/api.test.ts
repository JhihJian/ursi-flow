import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
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
  assert.deepEqual(list, [{ id: 't', label: 'test', provider: 'local', ready: true }])
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
