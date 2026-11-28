import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatRecord } from '../src/runtime/chat.ts'
import { liveFactsText, projectLiveFacts } from '../src/runtime/facts.ts'

/**
 * 运行事实投影：重放负责「文件里记了什么」，运行时只管重放拿不到的那几个字段。
 * 这里用假会话对象顶替 SDK 的 AgentSession：投影只读 `model` / `thinkingLevel`
 * 与活跃工具名，不需要真的装配一次运行时。
 */

const JSONL = [
  {
    type: 'header',
    id: 'facts-runtime',
    cwd: '/demo/alpha',
    timestamp: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 's1',
    parentId: null,
    type: 'message',
    timestamp: '2024-01-01T00:00:01.000Z',
    message: {
      role: 'system',
      sections: { skills: '<skill><name>demo</name><location>/demo/SKILL.md</location></skill>' },
      toolsAdded: [{ name: 'read' }],
    },
  },
  {
    id: 'a1',
    parentId: 's1',
    type: 'message',
    timestamp: '2024-01-01T00:00:02.000Z',
    message: { role: 'assistant', provider: 'prov', model: 'model-old', thinkingLevel: 'high', content: [] },
  },
]
  .map((row) => JSON.stringify(row))
  .join('\n') + '\n'

function fakeChat(over: { model?: string | null; thinkingLevel?: string | null; tools?: string[] | null } = {}) {
  return {
    model: over.model === undefined ? 'prov/model-new' : over.model,
    thinkingLevel: over.thinkingLevel === undefined ? 'low' : over.thinkingLevel,
    session: {
      ...(over.tools === null ? {} : { getActiveToolNames: () => over.tools ?? ['read', 'bash'] }),
    },
  } as unknown as ChatRecord
}

test('运行时投影：模型与思考等级以运行时为准，覆盖重放结果', () => {
  const facts = projectLiveFacts(fakeChat(), JSONL)
  assert.equal(facts.source, 'runtime')
  // 重放看到的是落盘时的旧模型，运行时手里的是切换后的新模型。
  assert.equal(facts.model.initial?.model, 'model-old')
  assert.deepEqual(facts.model.current, { provider: 'prov', model: 'model-new' })
  assert.equal(facts.model.thinkingLevel, 'low')
})

test('运行时投影：工具名取活跃工具，拿不到则保留重放结果', () => {
  assert.deepEqual(projectLiveFacts(fakeChat(), JSONL).tools.names, ['read', 'bash'])
  // SDK 没有 getActiveToolNames 时退回重放值，不编造空数组。
  assert.deepEqual(projectLiveFacts(fakeChat({ tools: null }), JSONL).tools.names, ['read'])
})

test('运行时投影：模型未知时不覆盖重放的模型事实', () => {
  const facts = projectLiveFacts(fakeChat({ model: null, thinkingLevel: null }), JSONL)
  assert.deepEqual(facts.model.current, { provider: 'prov', model: 'model-old' })
  assert.equal(facts.model.thinkingLevel, 'high')
})

test('liveFactsText：按会话管理器的头部与条目拼行文本', () => {
  const chat = {
    session: {
      sessionManager: {
        getHeader: () => ({ type: 'header', id: 'h1' }),
        getEntries: () => [{ id: 'e1' }, { id: 'e2' }],
      },
    },
  } as unknown as ChatRecord
  assert.equal(
    liveFactsText(chat),
    `${JSON.stringify({ type: 'header', id: 'h1' })}\n${JSON.stringify({ id: 'e1' })}\n${JSON.stringify({ id: 'e2' })}\n`,
  )
})
