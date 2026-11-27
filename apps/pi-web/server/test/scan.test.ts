import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createScanner } from '../src/sessions/scan.ts'
import {
  CANONICAL_ID,
  DEEP_ID,
  LEGACY_ID,
  LONG_ID,
  canonicalSession,
  makeFixtureRoot,
} from './fixtures.ts'

test('首次列目录只读头部：行可用，明细由后台补齐', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()

  const first = await scanner.list(root)
  assert.equal(first.root, root)
  assert.equal(first.truncated, false)
  assert.equal(first.sessions.length, 5)
  assert.equal(first.pendingDetails, 5)

  const alpha = first.sessions.find((session) => session.id === CANONICAL_ID)
  assert.equal(alpha.projectKey, '/demo/alpha')
  assert.equal(alpha.projectName, 'alpha')
  assert.equal(alpha.format, 'pi')
  assert.equal(alpha.detailsPending, true)
  assert.equal(alpha.messageCount, 0)
  assert.equal(alpha.size > 0, true)

  await scanner.whenIdle()
  const second = await scanner.list(root)
  assert.equal(second.pendingDetails, 0)
  const hydrated = second.sessions.find((session) => session.id === CANONICAL_ID)
  assert.equal(hydrated.detailsPending, false)
  assert.equal(hydrated.messageCount, 3)
  assert.equal(hydrated.name, '改过名的会话')
  assert.equal(hydrated.firstMessage, '第一条用户消息')
  // 最后活动时间来自最后一条消息，而不是文件 mtime
  assert.equal(hydrated.modified, Date.parse('2026-01-05T10:05:00.000Z'))
  assert.equal(hydrated.created, Date.parse('2026-01-05T10:00:00.000Z'))
})

test('老写法会话没有 session 头，按 legacy 收进来并从 uuid 字段取 id', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  const { sessions } = await scanner.list(root)
  await scanner.whenIdle()
  const legacy = (await scanner.list(root)).sessions.find((session) => session.projectName === 'beta')
  assert.equal(legacy.id, LEGACY_ID)
  assert.equal(legacy.format, 'legacy')
  assert.equal(legacy.detailsPending, false)
  assert.equal(legacy.messageCount, 2)
  assert.equal(legacy.firstMessage, '老格式提问')
  assert.equal(sessions.length, 5)
})

test('没有可用头部的 jsonl 仍然成行，按文件名给 id 并标 unknown', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  await scanner.list(root)
  await scanner.whenIdle()
  const { sessions } = await scanner.list(root)
  const broken = sessions.find((session) => session.id === 'broken')
  assert.ok(broken)
  assert.equal(broken.format, 'unknown')
  assert.equal(broken.messageCount, 0)
  assert.equal(broken.projectDir, 'proj-gamma')
})

test('扫描到三层子目录，第四层的会话不收', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  const first = await scanner.list(root)
  assert.deepEqual(
    first.sessions.map((session) => session.id).sort(),
    ['01a20000-0000-7000-8000-000000000001', '01a20000-0000-7000-8000-000000000002', DEEP_ID, LONG_ID, 'broken'].sort(),
  )
  assert.equal(
    first.sessions.some((session) => session.id === 'too-deep'),
    false,
  )
})

test('非 .jsonl 文件与符号链接目录外的内容都不进列表', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  const { sessions } = await scanner.list(root)
  assert.equal(sessions.some((session) => session.path.endsWith('notes.md')), false)
})

test('subagents 目录里的子代理记录不当成独立会话：它们只有父会话的 id', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  // pi 的写法：父会话一个 jsonl，旁边一个以会话 id 命名的目录放子代理对话。
  const subDir = join(root, 'proj-alpha', CANONICAL_ID, 'subagents')
  await mkdir(subDir, { recursive: true })
  await writeFile(
    join(subDir, 'agent-acompact-5b6686c16f601e2f.jsonl'),
    `${JSON.stringify({ type: 'user', sessionId: CANONICAL_ID, cwd: '/demo/alpha' })}\n`,
  )
  const scanner = createScanner()
  const { sessions } = await scanner.list(root)
  // 父会话只出现一次，子代理文件不出现。
  assert.equal(sessions.filter((session) => session.id === CANONICAL_ID).length, 1)
  assert.equal(sessions.some((session) => session.path.includes('subagents')), false)
})

test('文件没变化就不重读，追加内容后才重新补明细', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  // 关掉节流：这个用例要在同一秒内连续两次看到变化
  const scanner = createScanner({ detailThrottleMs: 0 })
  await scanner.list(root)
  await scanner.whenIdle()

  const cached = await scanner.list(root)
  assert.equal(cached.pendingDetails, 0)
  assert.equal(cached.sessions.find((s) => s.id === CANONICAL_ID).messageCount, 3)

  const path = join(root, 'proj-alpha', `2026-01-05T10-00-00-000Z_${CANONICAL_ID}.jsonl`)
  await writeFile(
    path,
    canonicalSession('/demo/alpha') +
      `${JSON.stringify({ type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-01-06T00:00:00.000Z', message: { role: 'user', content: '第三条' } })}\n`,
  )
  const changed = await scanner.list(root)
  assert.equal(changed.pendingDetails, 1)
  await scanner.whenIdle()
  const after = (await scanner.list(root)).sessions.find((s) => s.id === CANONICAL_ID)
  assert.equal(after.messageCount, 4)
  assert.equal(after.modified, Date.parse('2026-01-06T00:00:00.000Z'))
})

test('被删除的会话从结果里消失', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  await scanner.list(root)
  await rm(join(root, 'proj-beta', `${LEGACY_ID}.jsonl`))
  const { sessions } = await scanner.list(root)
  assert.equal(sessions.length, 4)
  assert.equal(sessions.some((session) => session.id === LEGACY_ID), false)
})

test('find 命中缓存与按文件名回退都返回同一行', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()

  const cold = await scanner.find(root, DEEP_ID)
  assert.equal(cold.id, DEEP_ID)
  assert.equal(cold.projectName, 'gamma')

  await scanner.list(root)
  const warm = await scanner.find(root, CANONICAL_ID.toUpperCase())
  assert.equal(warm.id, CANONICAL_ID)

  assert.equal(await scanner.find(root, '不存在'), null)
  assert.equal(await scanner.find(root, ''), null)
})

test('索引可以写入再读回，读回后不重新读文件', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = createScanner()
  await first.list(root)
  await first.whenIdle()
  const entries = JSON.parse(JSON.stringify(first.toJSON()))

  const second = createScanner()
  second.load(entries)
  const listing = await second.list(root)
  assert.equal(listing.pendingDetails, 0)
  assert.equal(listing.sessions.find((session) => session.id === CANONICAL_ID).messageCount, 3)

  const broken = second.load([{ size: 'x' }, null, { size: 1, mtimeMs: 2, info: { path: 1 } }])
  assert.equal(broken, undefined)
})

test('browse 列出子目录与各自直接包含的会话数，并按会话数排序', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  const listing = await scanner.browse(root)
  assert.equal(listing.path, root)
  assert.ok(listing.parent)
  assert.deepEqual(
    listing.dirs.map((dir) => [dir.name, dir.sessions]),
    [['proj-gamma', 1], ['proj-alpha', 1], ['proj-beta', 1], ['proj-delta', 1]].sort((a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0])),
  )
  assert.equal(await scanner.browse(join(root, 'nope')), null)
})

test('文件数超过上限时截断并标记', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner({ maxFiles: 2 })
  const { sessions, truncated } = await scanner.list(root)
  assert.equal(sessions.length, 2)
  assert.equal(truncated, true)
})

test('超长的首条用户消息被截断，列表与索引都不会被一条消息撑大', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  await scanner.list(root)
  await scanner.whenIdle()
  const { sessions } = await scanner.list(root)
  const long = sessions.find((session) => session.id === LONG_ID)
  assert.equal(long.firstMessage.length, 200)
  assert.equal(long.messageCount, 1)
  // 索引里也只留截断后的标题
  const stored = JSON.parse(JSON.stringify(scanner.toJSON()))
  const entry = stored.find((item) => item.info.id === LONG_ID)
  assert.equal(entry.info.firstMessage.length, 200)
  assert.equal('header' in entry, false)
})

test('刚补过明细的活跃会话只刷新大小与时间，不每轮重读整个文件', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const scanner = createScanner()
  await scanner.list(root)
  await scanner.whenIdle()

  const path = join(root, 'proj-alpha', `2026-01-05T10-00-00-000Z_${CANONICAL_ID}.jsonl`)
  await writeFile(
    path,
    canonicalSession('/demo/alpha') +
      `${JSON.stringify({ type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-01-06T00:00:00.000Z', message: { role: 'user', content: '第三条' } })}\n`,
  )
  const throttled = await scanner.list(root)
  assert.equal(throttled.pendingDetails, 0)
  const row = throttled.sessions.find((s) => s.id === CANONICAL_ID)
  assert.equal(row.messageCount, 3)
  assert.equal(row.detailsPending, false)
  // 文件时间照常更新，排序不会因为明细滞后而停在旧位置
  assert.equal(row.size, (await stat(path)).size)
  assert.ok(row.modified >= Date.parse('2026-01-06T00:00:00.000Z'))
})
