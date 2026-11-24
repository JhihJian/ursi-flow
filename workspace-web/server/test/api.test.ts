import test from 'node:test'
import assert from 'node:assert/strict'
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-web-test-'))
  const server = await createServer([{ id: 't', label: 'test', provider: 'local', root }])
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}/api/workspace-web`
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
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-web-out-'))
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
