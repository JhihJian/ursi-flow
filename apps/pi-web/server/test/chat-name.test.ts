import assert from 'node:assert/strict'
import test from 'node:test'
import { nameIfUnnamed } from '../src/chat/chat.ts'

/**
 * 没名字的会话用首条用户消息命名，名字经 SDK 写进会话文件，
 * 列表扫描、会话页标题、/name 改名都从同一处读。
 */

function fake(initial: { name: string | null; lastPrompt: string }) {
  const calls: string[] = []
  const session = { setSessionName: (name: string) => calls.push(name) }
  return { chat: { ...initial, session } as unknown as Parameters<typeof nameIfUnnamed>[0], calls }
}

test('没名字且收到过消息：用消息首行命名，折叠空白、截到 60 字', () => {
  const { chat, calls } = fake({ name: null, lastPrompt: '  帮我把\n\t注册表 的归属  改对  ' })
  nameIfUnnamed(chat)
  assert.deepEqual(calls, ['帮我把 注册表 的归属 改对'])

  const { chat: long, calls: longCalls } = fake({ name: null, lastPrompt: 'x'.repeat(100) })
  nameIfUnnamed(long)
  assert.equal(longCalls[0].length, 60)
})

test('已经有名字（用户 /name 过）不再覆盖', () => {
  const { chat, calls } = fake({ name: '我起的名字', lastPrompt: '随便' })
  nameIfUnnamed(chat)
  assert.deepEqual(calls, [])
})

test('还没收到过消息就不命名：空会话没有父节点可挂', () => {
  const { chat, calls } = fake({ name: null, lastPrompt: '' })
  nameIfUnnamed(chat)
  assert.deepEqual(calls, [])
})
