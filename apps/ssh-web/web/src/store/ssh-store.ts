import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { ApiError, SshApi } from '../api/client'
import type { Connection, ConnectionInput, TmuxSession } from '../api/types'

export type EditorTarget = { kind: 'new' } | { kind: 'edit'; connection: Connection }

/** 终端目标：attach 哪个 tmux 会话（null = 默认 ssh-main）。 */
export interface TerminalTarget {
  connectionId: number
  tmuxSession: string | null
}

/** 一个打开的终端标签：同一 (连接, tmux 会话) 只允许一个标签。 */
export interface TerminalTab extends TerminalTarget {
  /** 稳定标识：`{connectionId}/{tmuxSession ?? 'main'}`。 */
  key: string
  /** 终端生命周期：openTerminal 置 connecting，TerminalPane 按 WS/事件推进，卸载落 closed。 */
  state: TerminalState
}

/** 终端生命周期，驱动标签事件条展示。 */
export type TerminalState =
  | /** WS 建立中 */ 'connecting'
  | /** WS 已建立并可交互 */ 'live'
  | /** 远端会话正常结束 */ 'ended'
  | /** 连接失败 */ 'error'
  | /** 未打开 */ 'closed'

export function terminalKey(connectionId: number, tmuxSession: string | null): string {
  return `${connectionId}/${tmuxSession ?? 'main'}`
}

/** 单个连接的 tmux 会话列表状态：sessions 为 null 表示远端无 tmux，error 为查询失败原因。 */
export interface SessionsState {
  loading: boolean
  sessions: TmuxSession[] | null
  error: string | null
}

export interface SshStoreDeps {
  api: SshApi
  /** 亮暗主题的 localStorage 键；嵌入工作区时带模块前缀注入。 */
  storageKey?: string
}

export interface SshStoreState {
  connections: Connection[]
  /** 树中选中的连接；决定侧栏展开哪个连接的 tmux 会话子级。 */
  activeId: number | null
  /** 打开的终端标签，顺序即标签栏顺序。 */
  terminals: TerminalTab[]
  /** 当前激活的标签 key；null 表示全部关闭（显示占位）。 */
  activeTerminalKey: string | null
  /** 新建 tmux 会话表单是否展开（提交目标为 activeId）。 */
  sessionFormOpen: boolean
  /** 每个连接各自的 tmux 会话列表（树默认全展开，需要逐连接的数据）。 */
  sessionsByConnection: Record<number, SessionsState>
  editor: EditorTarget | null
  notice: string | null
  /** 终端面板亮色（白底）主题，跨刷新保留。 */
  terminalLight: boolean

  loadConnections: () => Promise<void>
  /** 选中连接：切换树选中并刷新该连接的 tmux 会话列表，不影响已打开的标签。 */
  selectConnection: (id: number) => Promise<void>
  /** 打开（或激活）一个终端标签：attach 指定 tmux 会话（null = 默认 ssh-main）。 */
  openTerminal: (connectionId: number, tmuxSession: string | null) => void
  /** 激活已打开的标签。 */
  activateTerminal: (key: string) => void
  /** 关闭标签（断开 WS；远端 tmux 会话保留），激活相邻标签。 */
  closeTerminal: (key: string) => void
  /** 由 TerminalPane 推进对应标签的生命周期。 */
  setTerminalState: (key: string, state: TerminalState) => void
  openSessionForm: () => void
  closeSessionForm: () => void
  /** 刷新指定连接（缺省为当前选中连接）的 tmux 会话列表。 */
  refreshTmuxSessions: (id?: number) => Promise<void>
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

/** 关闭一组标签后选出新的激活标签：优先保持原激活位置，否则取最后一个。 */
function nextActiveKey(terminals: TerminalTab[], closedKeys: Set<string>, activeKey: string | null): string | null {
  const remaining = terminals.filter((tab) => !closedKeys.has(tab.key))
  if (remaining.length === 0) return null
  if (activeKey !== null && !closedKeys.has(activeKey)) return activeKey
  const closedIndex = terminals.findIndex((tab) => closedKeys.has(tab.key))
  return remaining[Math.min(closedIndex, remaining.length - 1)]?.key ?? null
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
      // 默认亮色：模块整体是白底出版物风格，只有显式选过暗色才关掉。
      return window.localStorage.getItem(storageKey) !== 'false'
    } catch {
      return true
    }
  }

  return create<SshStoreState>((set, get) => ({
    connections: [],
    activeId: null,
    terminals: [],
    activeTerminalKey: null,
    sessionFormOpen: false,
    sessionsByConnection: {},
    editor: null,
    notice: null,
    terminalLight: readLight(),

    loadConnections: async () => {
      const { connections } = await api.listConnections()
      set({ connections })
      // 树默认全部展开：逐连接并行拉取会话列表，失败不影响其他连接。
      await Promise.allSettled(connections.map((connection) => get().refreshTmuxSessions(connection.id)))
    },

    selectConnection: async (id) => {
      if (get().activeId !== id) set({ activeId: id })
      await get().refreshTmuxSessions(id)
    },

    openTerminal: (connectionId, tmuxSession) => {
      const key = terminalKey(connectionId, tmuxSession)
      const { terminals } = get()
      if (terminals.some((tab) => tab.key === key)) {
        set({ activeTerminalKey: key, sessionFormOpen: false })
        return
      }
      set({
        terminals: [...terminals, { key, connectionId, tmuxSession, state: 'connecting' }],
        activeTerminalKey: key,
        sessionFormOpen: false,
        notice: null,
      })
    },

    activateTerminal: (key) => set({ activeTerminalKey: key }),

    closeTerminal: (key) => {
      const { terminals, activeTerminalKey } = get()
      const next = nextActiveKey(terminals, new Set([key]), activeTerminalKey)
      set({
        terminals: terminals.filter((tab) => tab.key !== key),
        activeTerminalKey: next,
        sessionFormOpen: false,
      })
    },

    setTerminalState: (key, state) =>
      set((current) => ({
        terminals: current.terminals.map((tab) =>
          tab.key === key ? { ...tab, state } : tab,
        ),
      })),

    openSessionForm: () => set({ sessionFormOpen: true }),
    closeSessionForm: () => set({ sessionFormOpen: false }),

    refreshTmuxSessions: async (id) => {
      const target = id ?? get().activeId
      if (target === null || target === undefined) return
      set((current) => ({
        sessionsByConnection: {
          ...current.sessionsByConnection,
          [target]: {
            loading: true,
            sessions: current.sessionsByConnection[target]?.sessions ?? null,
            error: null,
          },
        },
      }))
      try {
        const { sessions } = await api.listTmuxSessions(target)
        set((current) => ({
          sessionsByConnection: {
            ...current.sessionsByConnection,
            [target]: { loading: false, sessions, error: null },
          },
        }))
      } catch (error) {
        set((current) => ({
          sessionsByConnection: {
            ...current.sessionsByConnection,
            [target]: {
              loading: false,
              sessions: current.sessionsByConnection[target]?.sessions ?? null,
              error: toMessage(error),
            },
          },
        }))
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
      const { terminals, activeTerminalKey } = get()
      const closed = new Set(terminals.filter((tab) => tab.connectionId === id).map((tab) => tab.key))
      set({
        terminals: terminals.filter((tab) => !closed.has(tab.key)),
        activeTerminalKey: nextActiveKey(terminals, closed, activeTerminalKey),
        activeId: get().activeId === id ? null : get().activeId,
      })
      set((current) => {
        const sessionsByConnection = { ...current.sessionsByConnection }
        delete sessionsByConnection[id]
        return { sessionsByConnection }
      })
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
