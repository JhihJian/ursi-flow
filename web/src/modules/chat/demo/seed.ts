import type { ChatSession } from '@/shared/api/types'

export interface MockState { sequence: number; chatSessions: ChatSession[]; settings: { delay: number } }
export function createSeed(delay: number): MockState {
  const at = new Date().toISOString()
  return { sequence: 100, settings: { delay }, chatSessions: [{
    id: 'chat-1', title: '了解当前演示数据', createdAt: at, updatedAt: at,
    messages: [
      { id: 'example-question', role: 'user', at, parts: [{ type: 'text', text: '现在有哪些工作流和运行？' }] },
      { id: 'example-answer', role: 'assistant', at, parts: [
        { type: 'reasoning', text: '读取本地示例。' }, { type: 'tool', name: '读取运行记录', status: 'succeeded', output: '共 3 条示例运行' },
        { type: 'text', text: '示例工作区包含产品需求交付、代码审查和文档整理三个流程。\n\n> 本地演示回复，未调用模型。' },
      ] },
    ],
  }] }
}
