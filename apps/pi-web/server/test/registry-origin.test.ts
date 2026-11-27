import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { homes } from '../src/config/registry.ts'
import {
  collectionCursor,
  externalOrigin,
  homeOrigin,
  listEntities,
  originOfRoot,
  syncRuntime,
  upsertDisk,
  type DiskRow,
  type RuntimeSnapshot,
} from '../src/sessions/registry.ts'

/**
 * 磁盘上的会话文件没有归属：哪个作用域扫到它，它就归哪个作用域。
 * 同一个 sessions 目录既能按 home 访问也能按 root 访问，归属不对齐的话
 * 换一种访问方式列表就是空的。
 *
 * 但前端对 home 的 sessions/ 发的也是 root=，所以 root 命中某个已登记 home
 * 的 sessions/ 时必须按 home 算归属，否则 createChat 登记的 home 实体
 * 在按目录访问的列表里永远缺席。
 */

const disk = (id: string, modified: number): DiskRow => ({
  id,
  path: `/pi/sessions/${id}.jsonl`,
  projectDir: 'alpha',
  projectKey: '/demo/alpha',
  projectName: 'alpha',
  cwd: '/demo/alpha',
  firstMessage: '你好',
  messageCount: 1,
  created: modified,
  modified,
  size: 100,
  format: 'pi',
  detailsPending: false,
})

const HOME = homeOrigin('/pi')
const ROOT = externalOrigin('/pi/sessions')

test('按 home 登记过的会话，再按 root 扫到时归属跟着换过去', () => {
  const row = disk('origin-follows-scan', 1)
  upsertDisk(HOME, row)
  assert.equal(listEntities({ origin: ROOT }).length, 0)

  const before = collectionCursor().revision
  upsertDisk(ROOT, row)
  assert.equal(listEntities({ origin: ROOT }).length, 1)
  assert.equal(listEntities({ origin: HOME }).length, 0)
  // 归属变了，列表结果就变了，版本号要跟着走，否则带 since 的轮询拿不到新列表。
  assert.ok(collectionCursor().revision > before)

  // 再按 home 扫到又换回来，磁盘事实不变时版本号不动。
  const settled = collectionCursor().revision
  upsertDisk(HOME, row)
  assert.equal(listEntities({ origin: HOME }).length, 1)
  assert.ok(collectionCursor().revision > settled)
})

test('运行中的会话不换归属：它由启动它的作用域管到结束', () => {
  const row = disk('origin-stays-while-running', 1)
  const entity = upsertDisk(HOME, row)
  entity.state = 'running'
  upsertDisk(ROOT, { ...row, modified: 2, size: 200 })
  assert.equal(entity.origin.kind, 'home')
  assert.equal(listEntities({ origin: ROOT }).length, 0)
})

test('root 正好是某个已登记 home 的 sessions/ 时归属按 home 算，其它一律 external', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-origin-home-'))
  writeFileSync(join(dir, 'settings.json'), '{}')
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const home = await homes.add({ mode: 'adopt', path: dir, name: '归属测试' })
  try {
    const sessionsRoot = join(dir, 'sessions')
    assert.deepEqual(originOfRoot(sessionsRoot), homeOrigin(dir))
    assert.deepEqual(originOfRoot(sessionsRoot).kind, 'home')
    // home 根目录本身不是会话目录，不算 home 归属
    assert.deepEqual(originOfRoot(dir), externalOrigin(dir))
    assert.deepEqual(originOfRoot(join(dir, 'elsewhere')), externalOrigin(join(dir, 'elsewhere')))

    // 关键链路：运行时按 home 登记，列表按 root=.../sessions 查，要能查到
    const row = disk('origin-root-matches-home', 1)
    const entity = upsertDisk(homeOrigin(dir), row)
    entity.state = 'ready'
    const origin = originOfRoot(sessionsRoot)
    assert.ok(listEntities({ origin }).some((item) => item.id === entity.id))
  } finally {
    await homes.remove(home.id)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('心跳不刷 seenAt，实质变化（状态、标题）才刷', () => {
  const snap = (over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
    sessionId: 'seenat-only-on-change',
    kind: 'chat',
    homePath: '/pi',
    filePath: '/pi/sessions/seenat-only-on-change.jsonl',
    cwd: '/demo/alpha',
    state: 'ready',
    instanceId: 'inst-1',
    ...over,
  })
  const entity = syncRuntime(snap())
  const born = entity.seenAt

  // 心跳：一切照旧，seenAt 不动，版本号不动。先让时钟走一段，
  // 否则心跳与登记同一毫秒，刷不刷看不出来。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  assert.ok(Date.now() > born)
  const settled = collectionCursor().revision
  syncRuntime(snap())
  assert.equal(entity.seenAt, born)
  assert.equal(collectionCursor().revision, settled)

  // 状态变化：刷
  syncRuntime(snap({ state: 'running' }))
  const ran = entity.seenAt
  assert.ok(ran >= born)
  assert.ok(collectionCursor().revision > settled)

  // 标题变化：刷（新会话首条消息命名后列表要能拿到）
  syncRuntime(snap({ state: 'running', title: '首条消息' }))
  assert.ok(entity.seenAt >= ran)
  assert.equal(entity.title, '首条消息')
})
