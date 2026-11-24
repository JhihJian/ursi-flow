import { create } from 'zustand'
import { ApiClientError, WorkspaceApi, keyAppend, keyName, keySegments, keyToParent, makeKey } from './api.ts'
import type { EntryDto, WorkspaceInfo } from './api.ts'

export interface DirState {
  entries: EntryDto[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  /** 操作后置位；刷新或重取时清除。 */
  stale?: boolean
}

export interface OpenDir {
  key: string
  depth: number
}

interface TreeState {
  api: WorkspaceApi
  workspaces: WorkspaceInfo[]
  workspaceError?: string
  activeWorkspaceId: string | null
  dirs: Record<string, DirState>
  openDirs: OpenDir[]
  selectedDirKey: string | null
  lastError: string | null

  loadWorkspaces: () => Promise<void>
  selectWorkspace: (id: string | null) => void
  /** 运行时添加目录；成功后刷新清单并选中新 workspace。 */
  addWorkspace: (root: string) => Promise<string | null>
  /** 改显示名；id 与 root 不变，FileKey 与展开状态无需迁移。 */
  renameWorkspace: (id: string, label: string) => Promise<void>
  /** 从清单移除；返回被移除时是否是当前激活项（调用方负责清理编辑器与外壳选中）。 */
  removeWorkspace: (id: string) => Promise<boolean>
  toggleDir: (key: string) => Promise<void>
  reloadDir: (key: string) => Promise<void>
  refreshAll: () => Promise<void>
  selectDir: (key: string | null) => void
  createDir: (parentKey: string, name: string) => Promise<void>
  renameEntry: (key: string, newName: string) => Promise<void>
  removeEntry: (key: string) => Promise<void>
  setStaleAll: () => void
  clearError: () => void
  setApi: (api: WorkspaceApi) => void
}

function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function dirOf(dirs: Record<string, DirState>, key: string): DirState {
  return dirs[key] ?? { entries: [], status: 'idle' }
}

export interface TreeRowData {
  key: string
  depth: number
  kind: 'dir' | 'file'
  entry: EntryDto
  isOpen?: boolean
}

/**
 * 先序遍历：已展开目录产出自身行 + 子项行（子目录行仅当子目录已加载时才递归）。
 * 子项来自父目录的 entries 缓存；子目录展开状态查 openDirs。
 */
export function flattenOpen(openDirs: OpenDir[], dirs: Record<string, DirState>): TreeRowData[] {
  const rows: TreeRowData[] = []
  const openSet = new Set(openDirs.map((dir) => dir.key))

  const visit = (dirKey: string, depth: number): void => {
    const dir = dirs[dirKey]
    rows.push({ key: dirKey, depth, kind: 'dir', entry: { name: keyName(dirKey), type: 'dir', size: 0, mtime: 0 }, isOpen: openSet.has(dirKey) })
    if (!openSet.has(dirKey) || dir?.status !== 'ready') return
    for (const entry of dir.entries) {
      const childKey = keyAppend(dirKey, entry.name)
      if (entry.type === 'dir') {
        visit(childKey, depth + 1)
      } else {
        rows.push({ key: childKey, depth: depth + 1, kind: 'file', entry })
      }
    }
  }

  for (const dir of openDirs) {
    if (!keyToParent(dir.key)) visit(dir.key, 0)
  }
  return rows
}

export const useTreeStore = create<TreeState>((set, get) => ({
  api: new WorkspaceApi('/api/fs-web'),
  workspaces: [],
  activeWorkspaceId: null,
  dirs: {},
  openDirs: [],
  selectedDirKey: null,
  lastError: null,

  loadWorkspaces: async () => {
    try {
      const workspaces = await get().api.workspaces()
      // 当前选中在新清单中消失（被其他页面移除或服务重启清空）时复位。
      const current = get().activeWorkspaceId
      const stillExists = current !== null && workspaces.some((workspace) => workspace.id === current)
      set({ workspaces, workspaceError: undefined })
      if (current !== null && !stillExists) {
        get().selectWorkspace(null)
      }
      if (get().activeWorkspaceId === null) {
        const first = workspaces.find((workspace) => workspace.ready)?.id ?? null
        if (first) get().selectWorkspace(first)
      }
    } catch (error) {
      set({ workspaceError: messageOf(error) })
    }
  },

  selectWorkspace: (id) => {
    if (get().activeWorkspaceId === id) return
    if (id === null) {
      set({ activeWorkspaceId: null, dirs: {}, openDirs: [], selectedDirKey: null })
      return
    }
    const rootKey = makeKey(id, [])
    set({ activeWorkspaceId: id, dirs: {}, openDirs: [{ key: rootKey, depth: 0 }], selectedDirKey: null })
    void get().reloadDir(rootKey)
    void useGitRefreshOf().refresh(get().api, id)
  },

  addWorkspace: async (root) => {
    try {
      const workspace = await get().api.addWorkspace(root)
      set((current) => ({
        // 同名条目可能已在其他页面添加过：按 id 去重后重建列表。
        workspaces: [...current.workspaces.filter((item) => item.id !== workspace.id), workspace],
        workspaceError: undefined,
      }))
      get().selectWorkspace(workspace.id)
      return workspace.id
    } catch (error) {
      set({ workspaceError: messageOf(error) })
      return null
    }
  },

  renameWorkspace: async (id, label) => {
    try {
      const workspace = await get().api.renameWorkspace(id, label)
      set((current) => ({
        workspaces: current.workspaces.map((item) => (item.id === id ? workspace : item)),
      }))
    } catch (error) {
      set({ lastError: messageOf(error) })
    }
  },

  removeWorkspace: async (id) => {
    const wasActive = get().activeWorkspaceId === id
    try {
      await get().api.removeWorkspace(id)
      const rest = get().workspaces.filter((workspace) => workspace.id !== id)
      set({ workspaces: rest })
      if (wasActive) get().selectWorkspace(rest.find((workspace) => workspace.ready)?.id ?? null)
    } catch (error) {
      set({ lastError: messageOf(error) })
    }
    return wasActive
  },

  reloadDir: async (key) => {
    set((current) => ({
      dirs: { ...current.dirs, [key]: { ...dirOf(current.dirs, key), status: 'loading', stale: false } },
    }))
    try {
      const { workspaceId, path } = keySegments(key)
      const { entries } = await get().api.list(workspaceId, path)
      set((current) => ({ dirs: { ...current.dirs, [key]: { entries, status: 'ready' } } }))
    } catch (error) {
      set((current) => ({
        dirs: { ...current.dirs, [key]: { ...dirOf(current.dirs, key), status: 'error', error: messageOf(error) } },
      }))
    }
  },

  toggleDir: async (key) => {
    const state = get()
    if (state.openDirs.some((dir) => dir.key === key)) {
      // 折叠：移除自身与全部后代（子孙的 segments 数组以自身为前缀）。
      const ancestor = JSON.parse(key) as string[]
      const isDescendant = (child: string): boolean => {
        const parts = JSON.parse(child) as string[]
        return parts.length > ancestor.length && ancestor.every((segment, index) => parts[index] === segment)
      }
      const kept = state.openDirs.filter((dir) => dir.key !== key && !isDescendant(dir.key))
      set({ openDirs: kept })
      return
    }
    // 展开：depth 取父目录深度 + 1（根为 0）。
    const parent = keyToParent(key)
    const parentDepth = parent
      ? (state.openDirs.find((dir) => dir.key === parent.parentKey)?.depth ?? 0)
      : -1
    set({ openDirs: [...state.openDirs, { key, depth: parentDepth + 1 }] })
    await get().reloadDir(key)
  },

  refreshAll: async () => {
    for (const dir of get().openDirs) await get().reloadDir(dir.key)
    const id = get().activeWorkspaceId
    if (id) void useGitRefreshOf().refresh(get().api, id)
  },

  selectDir: (key) => set({ selectedDirKey: key }),

  createDir: async (parentKey, name) => {
    try {
      const { workspaceId, path } = keySegments(parentKey)
      await get().api.mkdir(workspaceId, [...path, name])
      await get().reloadDir(parentKey)
      void useGitRefreshOf().refresh(get().api, workspaceId)
    } catch (error) {
      set({ lastError: messageOf(error) })
    }
  },

  renameEntry: async (key, newName) => {
    const parent = keyToParent(key)
    if (!parent) return
    try {
      const { workspaceId, path } = keySegments(key)
      await get().api.rename(workspaceId, path, newName)
      // 迁移展开缓存：目录改名后自身与后代的 key 全部前缀替换，深度不变。
      const parts = JSON.parse(key) as string[]
      const renamed = JSON.stringify([...parts.slice(0, -1), newName])
      const remap = (candidate: string): string => {
        const segment = JSON.parse(candidate) as string[]
        const isSelfOrBelow =
          segment.length >= parts.length && parts.every((part, index) => segment[index] === part)
        if (!isSelfOrBelow) return candidate
        return JSON.stringify([...segment.slice(0, parts.length - 1), newName, ...segment.slice(parts.length)])
      }
      set((current) => ({
        openDirs: current.openDirs.map((dir) => ({ key: remap(dir.key), depth: dir.depth })),
        dirs: Object.fromEntries(
          Object.entries(current.dirs).map(([dirKey, dir]) => [remap(dirKey), dir]),
        ),
        selectedDirKey: current.selectedDirKey ? remap(current.selectedDirKey) : null,
      }))
      await get().reloadDir(parent.parentKey)
      void useGitRefreshOf().refresh(get().api, workspaceId)
    } catch (error) {
      set({ lastError: messageOf(error) })
    }
  },

  removeEntry: async (key) => {
    const parent = keyToParent(key)
    if (!parent) return
    try {
      const { workspaceId, path } = keySegments(key)
      await get().api.delete(workspaceId, path)
      await get().reloadDir(parent.parentKey)
      void useGitRefreshOf().refresh(get().api, workspaceId)
    } catch (error) {
      set({ lastError: messageOf(error) })
    }
  },

  setStaleAll: () => {
    const dirs = get().dirs
    const next: Record<string, DirState> = {}
    for (const [key, dir] of Object.entries(dirs)) {
      next[key] = dir.status === 'ready' ? { ...dir, stale: true } : dir
    }
    set({ dirs: next })
  },

  clearError: () => set({ lastError: null }),

  /** 模块工厂注入宿主配置的 apiBaseUrl。 */
  setApi: (api) => {
    set({ api })
    // 编辑器 discard 走注入实例。
    injectEditorApiOf(api)
  },
}))

export { useGitRefreshOf }

// 避免 tree-store 直接依赖 editor-store 造成环：用注入回调。
let editorApiInjector: ((api: WorkspaceApi) => void) | null = null
export function registerEditorApiInjector(fn: (api: WorkspaceApi) => void): void {
  editorApiInjector = fn
}
function injectEditorApiOf(api: WorkspaceApi): void {
  editorApiInjector?.(api)
}

// 同理，git-store 的 refresh 由模块层注入，避免模块依赖环。
interface GitRefreshLike {
  refresh: (api: WorkspaceApi, workspaceId: string) => Promise<void>
  reset: () => void
}
let gitRefresh: GitRefreshLike | null = null
export function registerGitRefresh(fn: GitRefreshLike): void {
  gitRefresh = fn
}
function useGitRefreshOf(): GitRefreshLike {
  if (!gitRefresh) throw new Error('git refresh 未注入')
  return gitRefresh
}
