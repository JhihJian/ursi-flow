import { create } from 'zustand'
import * as api from '../api/client'
import type { Connection, ConnectionInput, TmuxSession } from '../api/types'

export type EditorTarget = { kind: 'new' } | { kind: 'edit'; connection: Connection }

/** 终端目标：attach 哪个 tmux 会话（null = 默认 ssh-main）。 */
export interface TerminalTarget {
  connectionId: number
  tmuxSession: string | null
}

interface SshStoreState {
  connections: Connection[]
  activeId: number | null
  /** 当前终端目标；null 表示未打开终端（显示占位）。 */
  terminal: TerminalTarget | null
  /** terminal 存在即视为 connecting，WS 首帧或 error 后由 TerminalPane 呈现实际状态。 */
  /** tmux 会话列表；null 表示远端无 tmux 或查询失败（看 notice）。 */
  tmuxSessions: TmuxSession[] | null
  tmuxLoading: boolean
  editor: EditorTarget | null
  notice: string | null
  /** 终端面板亮色（白底）主题，跨刷新保留。 */
  terminalLight: boolean

  loadConnections: () => Promise<void>
  /** 选中连接：只切换选中并刷新 tmux 会话列表，不建连。 */
  selectConnection: (id: number) => Promise<void>
  /** 打开终端：attach 指定 tmux 会话（null = 默认 ssh-main）。 */
  openTerminal: (tmuxSession: string | null) => void
  /** 关闭终端（断开 WS；远端 tmux 会话保留）。 */
  closeTerminal: () => void
  refreshTmuxSessions: () => Promise<void>
  saveConnection: (target: EditorTarget, input: ConnectionInput) => Promise<void>
  removeConnection: (id: number) => Promise<void>
  setEditor: (editor: EditorTarget | null) => void
  setNotice: (message: string | null) => void
  toggleTerminalLight: () => void
}

function toMessage(error: unknown): string {
  if (error instanceof api.ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export const TERMINAL_LIGHT_KEY = 'ssh-web.terminal-light'

function initialTerminalLight(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_LIGHT_KEY) === 'true'
  } catch {
    return false
  }
}

export const useSshStore = create<SshStoreState>((set, get) => ({
  connections: [],
  activeId: null,
  terminal: null,
  tmuxSessions: null,
  tmuxLoading: false,
  editor: null,
  notice: null,
  terminalLight: initialTerminalLight(),

  loadConnections: async () => {
    const { connections } = await api.listConnections()
    set({ connections })
  },

  selectConnection: async (id) => {
    set({ activeId: id, terminal: null, tmuxSessions: null })
    await get().refreshTmuxSessions()
  },

  openTerminal: (tmuxSession) => {
    const id = get().activeId
    if (id === null) return
    set({ terminal: { connectionId: id, tmuxSession }, notice: null })
  },

  closeTerminal: () => set({ terminal: null }),

  refreshTmuxSessions: async () => {
    const id = get().activeId
    if (id === null) return
    set({ tmuxLoading: true })
    try {
      const { sessions } = await api.listTmuxSessions(id)
      set({ tmuxSessions: sessions, tmuxLoading: false })
    } catch (error) {
      set({ notice: toMessage(error), tmuxLoading: false })
    }
  },

  saveConnection: async (target, input) => {
    if (target.kind === 'new') {
      await api.createConnection(input)
      await get().loadConnections()
    } else {
      const { connection } = target
      await api.updateConnection(connection.id, input)
      await get().loadConnections()
    }
    set({ editor: null })
  },

  removeConnection: async (id) => {
    await api.deleteConnection(id)
    if (get().activeId === id) set({ activeId: null, terminal: null, tmuxSessions: null })
    await get().loadConnections()
  },

  setEditor: (editor) => set({ editor }),
  setNotice: (message) => set({ notice: message }),
  toggleTerminalLight: () =>
    set((state) => {
      const terminalLight = !state.terminalLight
      try {
        window.localStorage.setItem(TERMINAL_LIGHT_KEY, String(terminalLight))
      } catch {
        // 无 localStorage 时只在当前会话生效。
      }
      return { terminalLight }
    }),
}))
