import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CANONICAL_ID = '01a20000-0000-7000-8000-000000000001'
export const LEGACY_ID = '01a20000-0000-7000-8000-000000000002'
export const DEEP_ID = '01a20000-0000-7000-8000-000000000003'
export const LONG_ID = '01a20000-0000-7000-8000-000000000005'

const line = (row) => `${JSON.stringify(row)}\n`

/** 标准 pi 会话：session 头 + assistant/user 消息 + session_info 改名。 */
export function canonicalSession(cwd = '/demo/alpha', id = CANONICAL_ID) {
  return [
    line({ type: 'session', version: 3, id, timestamp: '2026-01-05T10:00:00.000Z', cwd }),
    line({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-05T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '第一条用户消息' }] },
    }),
    line({
      type: 'message',
      id: 'm2',
      parentId: 'm1',
      timestamp: '2026-01-05T10:02:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    }),
    line({ type: 'session_info', name: '改过名的会话' }),
    line({ type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-01-05T10:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '第二条' }] } }),
  ].join('')
}

/** 首条用户消息超长的会话：列表只应看到截断后的标题。 */
export function longMessageSession() {
  return [
    line({ type: 'session', version: 3, id: LONG_ID, timestamp: '2026-01-02T10:00:00.000Z', cwd: '/demo/delta' }),
    line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-02T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] } }),
  ].join('')
}

/** 老写法：没有 session 头，行是 user/assistant 且带 uuid/parentUuid。 */
export function legacySession() {
  return [
    line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-04T09:00:00.000Z', cwd: '/demo/beta', message: { role: 'user', content: [{ type: 'text', text: '老格式提问' }] } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-04T09:00:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '老格式回答' }] } }),
  ].join('')
}

/**
 * 一棵带各种边界的会话目录：
 * - `proj-alpha/`：标准会话（有 cwd 与改名）
 * - `proj-beta/`：老格式会话
 * - `proj-gamma/nested/deep/`：三层深的标准会话，刚好在扫描深度内
 * - `proj-gamma/broken.jsonl`：坏行 + 没有可用的头部
 */
export async function makeFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pi-sessions-scan-'))
  await mkdir(join(root, 'proj-alpha'), { recursive: true })
  await mkdir(join(root, 'proj-beta'), { recursive: true })
  await mkdir(join(root, 'proj-gamma', 'nested', 'deep', 'deeper'), { recursive: true })
  await mkdir(join(root, 'proj-delta'), { recursive: true })
  await writeFile(join(root, 'proj-alpha', `2026-01-05T10-00-00-000Z_${CANONICAL_ID}.jsonl`), canonicalSession())
  await writeFile(join(root, 'proj-beta', `${LEGACY_ID}.jsonl`), legacySession())
  await writeFile(join(root, 'proj-delta', `${LONG_ID}.jsonl`), longMessageSession())
  await writeFile(
    join(root, 'proj-gamma', 'nested', 'deep', `2026-01-03T08-00-00-000Z_${DEEP_ID}.jsonl`),
    canonicalSession('/demo/gamma', DEEP_ID),
  )
  // 第四层：超出扫描深度，只用来验证边界。
  await writeFile(join(root, 'proj-gamma', 'nested', 'deep', 'deeper', 'too-deep.jsonl'), canonicalSession('/demo/too-deep', 'too-deep'))
  await writeFile(join(root, 'proj-gamma', 'broken.jsonl'), `not json\n{"type":"other"}\n`)
  await writeFile(join(root, 'proj-gamma', 'notes.md'), '不是会话文件\n')
  return root
}

export { line }
