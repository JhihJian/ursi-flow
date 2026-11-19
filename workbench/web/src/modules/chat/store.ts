import { create } from 'zustand'

import { errorMessage } from '@/shared/api'
import { chatApi as api } from './demo/client'
import type { ChatMessage, ChatPart, ChatSession, ChatToolPart } from '@/shared/api/types'
import { streamChatMessage, type ChatStreamEvent } from './stream'

const TITLE_LENGTH = 24

export interface ChatState {
  sessions: ChatSession[]
  currentId: string | null
  loading: boolean
  streaming: boolean
  error: string
  loadSessions: () => Promise<void>
  createSession: (title?: string) => Promise<ChatSession | null>
  selectSession: (id: string | null) => void
  deleteSession: (id: string) => Promise<boolean>
  send: (text: string) => Promise<void>
  stop: () => void
  regenerate: () => Promise<void>
}

let controller: AbortController | null = null
let streamingId: string | null = null
let localSequence = 0
// 每次发送或停止都开启新的运行序号：旧运行的收尾不得覆盖新运行的流式状态。
let runSequence = 0
// 列表加载与会话详情补齐各自计数，避免互相作废旧响应。
let listGeneration = 0
let selectionGeneration = 0

const now = () => new Date().toISOString()
const trimTitle = (value: string) => Array.from(value.trim()).slice(0, TITLE_LENGTH).join('')

function currentSession(sessions: ChatSession[], id: string | null): ChatSession | undefined {
  return id ? sessions.find((session) => session.id === id) : undefined
}

function patchSession(sessions: ChatSession[], id: string, update: (session: ChatSession) => ChatSession): ChatSession[] {
  return sessions.map((session) => (session.id === id ? update(session) : session))
}

function patchMessage(sessions: ChatSession[], sessionId: string, messageId: string, update: (message: ChatMessage) => ChatMessage): ChatSession[] {
  return patchSession(sessions, sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) => (message.id === messageId ? update(message) : message)),
  }))
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

/** 分段文本并入最后一段 text，保持工具与推理块的原始顺序。 */
function appendText(parts: ChatPart[], text: string): ChatPart[] {
  const last = parts.at(-1)
  if (last?.type === 'text') return [...parts.slice(0, -1), { type: 'text', text: last.text + text }]
  return [...parts, { type: 'text', text }]
}

/** 同名工具只保留一条，状态与输出按最新事件更新。 */
function upsertTool(parts: ChatPart[], event: ChatToolPart): ChatPart[] {
  const index = parts.findIndex((part) => part.type === 'tool' && part.name === event.name)
  if (index < 0) return [...parts, event]
  const next = [...parts]
  next[index] = event
  return next
}

/**
 * 对话状态：会话列表、当前会话、流式标记与错误。
 * 发送时先乐观追加用户消息与助手占位消息，再按流事件补齐内容，停止时保留已生成的片段。
 */
export const useChatStore = create<ChatState>((set, get) => {
  async function run(sessionId: string, text: string, draftId: string, regenerate: boolean): Promise<void> {
    const runId = ++runSequence
    const abort = new AbortController()
    controller = abort
    streamingId = sessionId
    // 过期运行不再写入任何状态，避免停止后立即重发时分段与收尾相互覆盖。
    const isCurrent = () => runId === runSequence
    const apply = (event: ChatStreamEvent) => {
      if (!isCurrent()) return
      if (event.type === 'delta') {
        set((state) => ({ sessions: patchMessage(state.sessions, sessionId, draftId, (message) => ({ ...message, parts: appendText(message.parts, event.text) })) }))
        return
      }
      if (event.type === 'tool') {
        const part: ChatToolPart = { type: 'tool', name: event.name, status: event.status, ...(event.output ? { output: event.output } : {}) }
        set((state) => ({ sessions: patchMessage(state.sessions, sessionId, draftId, (message) => ({ ...message, parts: upsertTool(message.parts, part) })) }))
      }
    }
    try {
      const reply = await streamChatMessage(sessionId, text, { signal: abort.signal, regenerate, onEvent: apply })
      if (reply) {
        set((state) => ({ sessions: patchMessage(state.sessions, sessionId, draftId, () => reply) }))
      }
    } catch (cause) {
      if (!isAbort(cause) && isCurrent()) {
        set({ error: errorMessage(cause) })
        // 失败且没有收到任何片段时不保留空占位消息。
        set((state) => ({ sessions: patchSession(state.sessions, sessionId, (session) => ({ ...session, messages: session.messages.filter((message) => message.id !== draftId || message.parts.length > 0) })) }))
      }
    } finally {
      // 只有当前运行才能收尾，停止后立即重发的旧运行不得清掉新流的状态。
      if (isCurrent()) {
        controller = null
        streamingId = null
        set({ streaming: false })
      }
    }
  }

  return {
    sessions: [],
    currentId: null,
    loading: false,
    streaming: false,
    error: '',

    loadSessions: async () => {
      const current = ++listGeneration
      set({ loading: true, error: '' })
      try {
        const sessions = await api.get<ChatSession[]>('/chat/sessions')
        if (current !== listGeneration) return
        set({ sessions, loading: false })
      } catch (cause) {
        if (current !== listGeneration) return
        set({ loading: false, error: errorMessage(cause) })
      }
    },

    createSession: async (title) => {
      try {
        const session = await api.post<ChatSession>('/chat/sessions', title ? { title } : {})
        set((state) => ({ sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)], currentId: session.id, error: '' }))
        return session
      } catch (cause) {
        set({ error: errorMessage(cause) })
        return null
      }
    },

    selectSession: (id) => {
      selectionGeneration += 1
      set({ currentId: id, error: '' })
      if (!id || get().sessions.some((session) => session.id === id)) return
      // 直接进入会话地址时补齐列表里还没有的记录。
      const current = selectionGeneration
      void api.get<ChatSession>(`/chat/sessions/${encodeURIComponent(id)}`)
        .then((session) => {
          if (current !== selectionGeneration) return
          set((state) => ({ sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)] }))
        })
        .catch((cause: unknown) => {
          if (current !== selectionGeneration) return
          set({ error: errorMessage(cause) })
        })
    },

    deleteSession: async (id) => {
      try {
        await api.delete(`/chat/sessions/${encodeURIComponent(id)}`)
      } catch (cause) {
        set({ error: errorMessage(cause) })
        return false
      }
      if (streamingId === id) get().stop()
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        currentId: state.currentId === id ? null : state.currentId,
      }))
      return true
    },

    send: async (text) => {
      const value = text.trim()
      const { currentId, streaming, sessions } = get()
      if (!value || !currentId || streaming) return
      const session = currentSession(sessions, currentId)
      if (!session) return
      const at = now()
      const user: ChatMessage = { id: `local-user-${++localSequence}`, role: 'user', at, parts: [{ type: 'text', text: value }] }
      const draft: ChatMessage = { id: `local-assistant-${++localSequence}`, role: 'assistant', at, parts: [] }
      set((state) => ({
        sessions: patchSession(state.sessions, currentId, (item) => ({
          ...item,
          title: item.messages.length ? item.title : trimTitle(value),
          messages: [...item.messages, user, draft],
          updatedAt: at,
        })),
        streaming: true,
        error: '',
      }))
      await run(currentId, value, draft.id, false)
    },

    stop: () => {
      // 序号自增让旧运行的收尾失效，否则它会清掉下一次发送的流式状态。
      runSequence += 1
      controller?.abort()
      controller = null
      streamingId = null
      set({ streaming: false })
    },

    regenerate: async () => {
      const { currentId, streaming, sessions } = get()
      const session = currentSession(sessions, currentId)
      if (!currentId || streaming || !session) return
      const lastUser = [...session.messages].reverse().find((message) => message.role === 'user')
      if (!lastUser) return
      const prompt = lastUser.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      const messages = [...session.messages]
      while (messages.at(-1)?.role === 'assistant') messages.pop()
      const draft: ChatMessage = { id: `local-assistant-${++localSequence}`, role: 'assistant', at: now(), parts: [] }
      set((state) => ({ sessions: patchSession(state.sessions, currentId, (item) => ({ ...item, messages: [...messages, draft] })), streaming: true, error: '' }))
      await run(currentId, prompt, draft.id, true)
    },
  }
})
