import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTransformer, detectFormat } from '../src/canonicalize.mjs'
import { createLocator, projectDirOf, SESSION_ID } from '../src/locate.mjs'

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname

const lines = async (path) => {
  const { readFile } = await import('node:fs/promises')
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
}

const meta = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  project: '/tmp/legacy',
  timestamp: '2026-11-01T11:00:00.000Z',
}

test('detectFormat 区分两种写法', async () => {
  assert.equal(detectFormat(JSON.parse((await lines(fixture('pi-v3.jsonl')))[0])), 'pi')
  assert.equal(detectFormat(JSON.parse((await lines(fixture('claude-code.jsonl')))[1])), 'claude-code')
  assert.equal(detectFormat({ type: 'last-prompt' }), 'unknown')
  assert.equal(detectFormat(null), 'unknown')
})

test('Pi v3 文件补头后原样通过', async () => {
  const transformer = createTransformer(meta)
  const output = (await lines(fixture('pi-v3.jsonl'))).flatMap((line) => transformer.transform(line))
  assert.equal(output.length, 4)
  assert.equal(JSON.parse(output[0]).type, 'session')
  assert.equal(JSON.parse(output[2]).message.role, 'user')
  assert.equal(transformer.skipped, 0)
})

test('Claude Code 风格补出头行并改成 message 行', async () => {
  const transformer = createTransformer(meta)
  const output = (await lines(fixture('claude-code.jsonl'))).flatMap((line) => transformer.transform(line))
  const rows = output.map((line) => JSON.parse(line))

  const header = rows[0]
  assert.equal(header.type, 'session')
  assert.equal(header.id, meta.sessionId)
  assert.equal(header.cwd, '/tmp/legacy')

  const messages = rows.filter((row) => row.type === 'message')
  assert.equal(messages.length, 2)
  assert.deepEqual(
    messages.map((row) => [row.id, row.parentId, row.message.role]),
    [
      ['c1', null, 'user'],
      ['c2', 'c1', 'assistant'],
    ],
  )
  // 未知类型原样保留，组件库会忽略
  assert.ok(rows.some((row) => row.type === 'queue-operation'))
  assert.ok(rows.some((row) => row.type === 'last-prompt'))
})

test('坏行被丢弃并计数，重复的 session 头只保留一条', () => {
  const transformer = createTransformer(meta)
  const output = [
    transformer.transform('{"type":"session","version":3}'),
    transformer.transform('{"type":"session","version":3}'),
    transformer.transform('not json'),
    transformer.transform('   '),
    transformer.transform('{"type":"message","id":"x","message":{"role":"user","content":[]}}'),
  ].flat()
  assert.equal(output.filter((line) => line.includes('"session"')).length, 1)
  assert.equal(transformer.skipped, 1)
  assert.ok(output.some((line) => line.includes('"message"')))
})

test('缺少 uuid 时按顺序串联 parentId，避免分支被裁掉', () => {
  const transformer = createTransformer(meta)
  const rows = [
    transformer.transform('{"type":"user","message":{"role":"user","content":"a"}}'),
    transformer.transform('{"type":"assistant","message":{"role":"assistant","content":"b"}}'),
  ].flat().map((line) => JSON.parse(line))
  const messages = rows.filter((row) => row.type === 'message')
  assert.equal(messages[0].parentId, null)
  assert.equal(messages[1].parentId, messages[0].id)
})

test('projectDirOf 保留原始目录名，不猜真实路径', () => {
  assert.equal(projectDirOf('/root/sessions/--data-dev-ursi-flow--/a.jsonl'), '--data-dev-ursi-flow--')
  assert.equal(projectDirOf('/root/sessions/cybergym/a.jsonl'), 'cybergym')
})

test('createLocator 按文件名建索引并取最新一份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-viewer-'))
  const first = join(root, '--tmp-demo--')
  const second = join(root, 'other')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  const id = '33333333-3333-4333-8333-333333333333'
  const older = join(first, `2026-11-01T00-00-00-000Z_${id}.jsonl`)
  const newer = join(second, `2026-11-02T00-00-00-000Z_${id}.jsonl`)
  await writeFile(older, '{}\n')
  await writeFile(newer, '{}\n')
  await utimes(older, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))
  await utimes(newer, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'))
  await writeFile(join(first, '2026-11-01T00-00-00-000Z_not-an-id.jsonl'), '{}\n')

  const locator = createLocator({ roots: [root], ttlMs: 1000 })
  assert.equal(await locator.size(), 1)
  const hit = await locator.find(id)
  assert.equal(hit.id, id)
  assert.equal(hit.candidates.length, 1, '保留另一份作为候选')
  assert.ok(hit.path.includes('2026-11-02'), '取 mtime 最新的一份')

  assert.equal(await locator.find('../../etc/passwd'), null)
  assert.equal(SESSION_ID.test(id), true)
})
