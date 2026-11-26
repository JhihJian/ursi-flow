import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { deleteSessionFile } from '../src/sessions/delete.ts'
import { applyPinnedChange, createPrefs, normalizePinned } from '../src/sessions/prefs.ts'
import { CANONICAL_ID, makeFixtureRoot } from './fixtures.ts'

test('关注列表去掉非法项与重复，保留首次出现的顺序', () => {
  assert.deepEqual(normalizePinned(['/a', '/b', '/a', 1, null, '', '/c']), ['/a', '/b', '/c'])
  assert.deepEqual(normalizePinned('nope'), [])
  assert.deepEqual(normalizePinned(['__proto__', '/a']), ['/a'])
  assert.deepEqual(normalizePinned(Array.from({ length: 200 }, (_, i) => `/p${i}`)).length, 100)
})

test('pin 把项目放到最前，重复 pin 不产生第二份，unpin 只去掉它', () => {
  assert.deepEqual(applyPinnedChange([], { pin: '/a' }), ['/a'])
  assert.deepEqual(applyPinnedChange(['/a', '/b'], { pin: '/a' }), ['/a', '/b'])
  assert.deepEqual(applyPinnedChange(['/a', '/b'], { pin: '/b' }), ['/b', '/a'])
  assert.deepEqual(applyPinnedChange(['/a', '/b'], { unpin: '/a' }), ['/b'])
  assert.deepEqual(applyPinnedChange(['/a'], { unpin: '/nope' }), ['/a'])
  assert.deepEqual(applyPinnedChange(['/a'], {}), ['/a'])
})

test('偏好写盘后能读回，损坏的文件退回默认值', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'state', 'prefs.json')

  const first = createPrefs({ file })
  await first.load()
  assert.deepEqual(first.get(), { pinnedProjects: [] })
  await first.apply({ pin: '/demo/alpha' })
  await first.apply({ pin: '/demo/beta' })
  assert.deepEqual(first.get().pinnedProjects, ['/demo/beta', '/demo/alpha'])

  const second = createPrefs({ file })
  await second.load()
  assert.deepEqual(second.get().pinnedProjects, ['/demo/beta', '/demo/alpha'])

  await writeFile(file, 'not json')
  const third = createPrefs({ file })
  await third.load()
  assert.deepEqual(third.get().pinnedProjects, [])
})

test('apply 报告是否真的改了，重复的请求不重写文件', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const prefs = createPrefs({ file: join(root, 'prefs.json') })
  await prefs.load()
  assert.equal((await prefs.apply({ pin: '/a' })).changed, true)
  assert.equal((await prefs.apply({ pin: '/a' })).changed, false)
  assert.equal((await prefs.apply({ unpin: '/nope' })).changed, false)
  assert.equal((await prefs.apply({ unpin: '/a' })).changed, true)
})

test('删除会话同时删掉同名 subagent 目录', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionPath = join(root, 'proj-alpha', `2026-01-05T10-00-00-000Z_${CANONICAL_ID}.jsonl`)
  const subagentDir = sessionPath.replace(/\.jsonl$/, '')
  await mkdir(join(subagentDir, 'subagents'), { recursive: true })
  await writeFile(join(subagentDir, 'subagents', 'agent-a.jsonl'), '{}\n')

  const result = await deleteSessionFile({ path: sessionPath, root })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.removed, [sessionPath, subagentDir])
  assert.equal(await stat(sessionPath).catch(() => null), null)
  assert.equal(await stat(subagentDir).catch(() => null), null)
  // 同一个项目目录里的其它会话不受影响
  assert.ok(await readFile(join(root, 'proj-gamma', 'broken.jsonl'), 'utf8'))
})

test('没有同名目录时只删文件；文件已不存在返回 404', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionPath = join(root, 'proj-gamma', 'broken.jsonl')

  const result = await deleteSessionFile({ path: sessionPath, root })
  assert.deepEqual(result.removed, [sessionPath])

  const again = await deleteSessionFile({ path: sessionPath, root })
  assert.equal(again.error[0], 404)
})

test('根目录之外的路径与非 jsonl 文件都拒绝删除', async (t) => {
  const root = await makeFixtureRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const outside = await deleteSessionFile({ path: '/tmp/evil.jsonl', root })
  assert.equal(outside.error[0], 400)

  const notes = await deleteSessionFile({ path: join(root, 'proj-gamma', 'notes.md'), root })
  assert.equal(notes.error[0], 400)
  assert.ok(await stat(join(root, 'proj-gamma', 'notes.md')))
})
