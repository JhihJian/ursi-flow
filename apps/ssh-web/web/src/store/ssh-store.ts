import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ApiError, SshApi } from '../api/client'
import type { Connection, ConnectionInput, TmuxSession } from '../api/types'

export type EditorTarget = { kind: 'new' } | { kind: 'edit'; connection: Connection }

/** 终端目标：attach 哪个 tmux 会话（null = 默认 ssh-main）。 */
export interface TerminalTarget {
  connectionId: number
  tmuxSession: string | null
}

/** 终端生命周期，驱动折叠摘要与事件条展示。 */
export type TerminalState =
  | /** 打开了目标，WS 建立中 */ 'connecting'
  | /** WS 已建立并可交互 */ 'live'
  | /** 远端会话正常结束 */ 'ended'
  | /** 连接失败 */ 'error'
  | /** 未打开或面板已卸载 */ 'closed'

export interface SshStoreDeps {
  api: SshApi
  /** 亮暗主题的 localStorage 键；嵌入工作区时带模块前缀注入。 */
  storageKey?: string
}

export interface SshStoreState {
  connections: Connection[]
  activeId: number | null
  /** 当前终端目标；null 表示未打开终端（显示占位）。 */
  terminal: TerminalTarget | null
  /** 终端生命周期：openTerminal 置 connecting，TerminalPane 按 WS/事件推进，卸载落 closed。 */
  terminalState: TerminalState
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
  /** 由 TerminalPane 推进生命周期；桥卸载时传 closed。 */
  setTerminalState: (state: TerminalState) => void
  refreshTmuxSessions: () => Promise<void>
  saveConnection: (target: EditorTarget, input: ConnectionInput) => Promise<void>
  removeConnection: (id: number) => Promise<void>
  setEditor: (editor: EditorTarget | null) => void
  setNotice: (message: string | null) => void
  toggleTerminalLight: () => void
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 创建一条 ssh-web store。store 不是模块级单例：api 前缀与 storage 键都由工厂注入，
 * 一页一个实例（工作区 registry 单实例成立），第二个实例会共享 localStorage 但各自持内存状态。
 */
export function createSshStore(
  deps: SshStoreDeps,
): UseBoundStore<StoreApi<SshStoreState>> {
  const { api } = deps
  const storageKey = deps.storageKey ?? 'ssh.terminal-light'

  const readLight = (): boolean => {
    try {
      return window.localStorage.getItem(storageKey) === 'true'
    } catch {
      return false
    }
  }

  return create<SshStoreState>((set, get) => ({
    connections: [],
    activeId: null,
    terminal: null,
    terminalState: 'closed',
    tmuxSessions: null,
    tmuxLoading: false,
    editor: null,
    notice: null,
    terminalLight: readLight(),

    loadConnections: async () => {
      const { connections } = await api.listConnections()
      set({ connections })
    },

    selectConnection: async (id) => {
      set({ activeId: id, terminal: null, terminalState: 'closed', tmuxSessions: null })
      await get().refreshTmuxSessions()
    },

    openTerminal: (tmuxSession) => {
      const id = get().activeId
      if (id === null) return
      set({ terminal: { connectionId: id, tmuxSession }, terminalState: 'connecting', notice: null })
    },

    closeTerminal: () => set({ terminal: null, terminalState: 'closed' }),

    setTerminalState: (state) => set({ terminalState: state }),

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
      if (get().activeId === id)
        set({ activeId: null, terminal: null, terminalState: 'closed', tmuxSessions: null })
      await get().loadConnections()
    },

    setEditor: (editor) => set({ editor }),
    setNotice: (message) => set({ notice: message }),
    toggleTerminalLight: () =>
      set((state) => {
        const terminalLight = !state.terminalLight
        try {
          window.localStorage.setItem(storageKey, String(terminalLight))
        } catch {
          // 无 localStorage 时只在当前会话生效。
        }
        return { terminalLight }
      }),
  }))
}
