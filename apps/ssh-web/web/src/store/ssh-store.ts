import { create } from 'zustand'
import * as api from '../api/client'
import type { Connection, ConnectionInput, SessionInfo } from '../api/types'

export type EditorTarget = { kind: 'new' } | { kind: 'edit'; connection: Connection }

interface SshStoreState {
  connections: Connection[]
  activeId: number | null
  activeSession: SessionInfo | null
  connecting: boolean
  editor: EditorTarget | null
  notice: string | null

  loadConnections: () => Promise<void>
  selectConnection: (id: number) => Promise<void>
  saveConnection: (target: EditorTarget, input: ConnectionInput) => Promise<void>
  removeConnection: (id: number) => Promise<void>
  setEditor: (editor: EditorTarget | null) => void
  setActiveSession: (session: SessionInfo | null) => void
  setNotice: (message: string | null) => void
}

function toMessage(error: unknown): string {
  if (error instanceof api.ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export const useSshStore = create<SshStoreState>((set, get) => ({
  connections: [],
  activeId: null,
  activeSession: null,
  connecting: false,
  editor: null,
  notice: null,

  loadConnections: async () => {
    const { connections } = await api.listConnections()
    set({ connections })
  },

  selectConnection: async (id) => {
    if (get().activeId === id && get().activeSession) return
    const connection = get().connections.find((item) => item.id === id)
    if (!connection) return
    set({ connecting: true, activeId: id, activeSession: null, notice: null })
    try {
      const { session } = await api.connectConnection(id)
      set({ activeSession: session, connecting: false })
    } catch (error) {
      set({ activeId: id, activeSession: null, connecting: false, notice: toMessage(error) })
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
    if (get().activeId === id) set({ activeId: null, activeSession: null })
    await get().loadConnections()
  },

  setEditor: (editor) => set({ editor }),
  setActiveSession: (session) => set({ activeSession: session }),
  setNotice: (message) => set({ notice: message }),
}))
