import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectionCursor,
  externalOrigin,
  homeOrigin,
  listEntities,
  upsertDisk,
  type DiskRow,
} from '../src/sessions/registry.ts'

/**
 * 磁盘上的会话文件没有归属：哪个作用域扫到它，它就归哪个作用域。
 * 同一个 sessions 目录既能按 home 访问也能按 root 访问，归属不对齐的话
 * 换一种访问方式列表就是空的。
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
