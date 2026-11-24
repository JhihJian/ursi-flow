import { create } from 'zustand'
import { ApiClientError, keySegments } from './api.ts'
import type { WorkspaceApi } from './api.ts'

export interface EditorEntry {
  status: 'loading' | 'ready' | 'error'
  draft: string
  /** 打开时基线，保存携带做乐观锁。 */
  mtime: number
  dirty: boolean
  /** 保存遇 409 后置位；提供覆盖保存 / 放弃两条路。 */
  conflict?: boolean
  error?: string
}

interface EditorState {
  editors: Record<string, EditorEntry>
  openFile: (api: WorkspaceApi, key: string) => Promise<void>
  closeFile: (key: string) => void
  updateDraft: (key: string, value: string) => void
  save: (api: WorkspaceApi, key: string, overwrite?: boolean) => Promise<void>
  discard: (key: string) => Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useEditorStore = create<EditorState>((set, get) => ({
  editors: {},

  openFile: async (api, key) => {
    const existing = get().editors[key]
    if (existing?.status === 'ready' && !existing.conflict) return
    set((current) => ({
      editors: {
        ...current.editors,
        [key]: existing?.status === 'ready'
          ? existing
          : { status: 'loading', draft: '', mtime: 0, dirty: false },
      },
    }))
    try {
      const { workspaceId, path } = keySegments(key)
      const result = await api.read(workspaceId, path)
      set((current) => ({
        editors: {
          ...current.editors,
          [key]: { status: 'ready', draft: result.content, mtime: result.mtime, dirty: false },
        },
      }))
    } catch (error) {
      set((current) => ({
        editors: {
          ...current.editors,
          [key]: { status: 'error', draft: '', mtime: 0, dirty: false, error: messageOf(error) },
        },
      }))
    }
  },

  closeFile: (key) => {
    set((current) => {
      const editors = { ...current.editors }
      delete editors[key]
      return { editors }
    })
  },

  updateDraft: (key, value) => {
    set((current) => {
      const entry = current.editors[key]
      if (!entry) return current
      return { editors: { ...current.editors, [key]: { ...entry, draft: value, dirty: true } } }
    })
  },

  save: async (api, key, overwrite = false) => {
    const entry = get().editors[key]
    if (!entry || entry.status !== 'ready') return
    try {
      const { workspaceId, path } = keySegments(key)
      const result = await api.write(workspaceId, path, entry.draft, {
        expectMtime: entry.mtime,
        overwrite,
      })
      set((current) => ({
        editors: {
          ...current.editors,
          [key]: { ...current.editors[key]!, draft: entry.draft, mtime: result.mtime, dirty: false, conflict: undefined },
        },
      }))
      saveListener?.(workspaceId)
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'conflict') {
        set((current) => ({
          editors: { ...current.editors, [key]: { ...current.editors[key]!, conflict: true } },
        }))
        return
      }
      set((current) => ({
        editors: { ...current.editors, [key]: { ...current.editors[key]!, error: messageOf(error) } },
      }))
    }
  },

  discard: async (key) => {
    // 放弃修改：重新拉取服务端内容。
    const entry = get().editors[key]
    if (!entry) return
    set((current) => ({
      editors: { ...current.editors, [key]: { ...current.editors[key]!, conflict: undefined, status: 'loading' } },
    }))
    const { workspaceId, path } = keySegments(key)
    try {
      const result = await getApiOf().read(workspaceId, path)
      set((current) => ({
        editors: {
          ...current.editors,
          [key]: { status: 'ready', draft: result.content, mtime: result.mtime, dirty: false },
        },
      }))
    } catch (error) {
      set((current) => ({
        editors: { ...current.editors, [key]: { ...current.editors[key]!, status: 'error', error: messageOf(error) } },
      }))
    }
  },
}))

// discard 需要发请求；api 实例由模块注入，避免重复构造。
let injectedApi: WorkspaceApi | null = null
export function injectEditorApi(api: WorkspaceApi): void {
  injectedApi = api
}
function getApiOf(): WorkspaceApi {
  if (!injectedApi) throw new Error('editor api 未注入')
  return injectedApi
}

// 保存成功后通知 git-store 刷新快照；由模块层注入避免依赖环。
let saveListener: ((workspaceId: string) => void) | null = null
export function registerGitSaveListener(fn: (workspaceId: string) => void): void {
  saveListener = fn
}
