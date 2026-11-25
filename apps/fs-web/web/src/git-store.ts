import { create } from 'zustand'
import { ApiClientError, keySegments } from './api.ts'
import type { GitChangeDto, GitStatusDto, WorkspaceApi } from './api.ts'

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** 树内徽标展示字母：冲突码归并为 U；untracked 目录显示 U。 */
export function badgeCodeOf(change: GitChangeDto): string {
  if (CONFLICT_CODES.has(`${change.index}${change.worktree}`)) return 'U'
  if (change.index === '?' || change.worktree === '?') return 'U'
  return change.index !== ' ' ? change.index : change.worktree
}

export interface GitSyncState {
  /** 进行中的同步方向；null 表示空闲。 */
  phase: 'push' | 'pull' | null
  /** 本次同步的开始时间（毫秒），用于状态栏耗时显示。 */
  startedAt: number
  /** 上一次同步失败的错误；成功后清空。 */
  error: string | null
}

export interface GitState {
  /** 非 null 表示已确认为仓库；null 表示尚未加载或非仓库。 */
  snapshot: (GitStatusDto & { isRepo: true }) | null
  loading: boolean
  error: string | null
  /** push/pull 进行中状态与上次错误。 */
  sync: GitSyncState
  refresh: (api: WorkspaceApi, workspaceId: string) => Promise<void>
  /** 推送/拉取当前分支；失败时记录错误不抛出，结束或失败后都刷新快照。 */
  syncUpstream: (api: WorkspaceApi, workspaceId: string, phase: 'push' | 'pull') => Promise<void>
  reset: () => void
  clearError: () => void
  clearSyncError: () => void
}

let requestSeq = 0

export const useGitStore = create<GitState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  sync: { phase: null, startedAt: 0, error: null },

  refresh: async (api, workspaceId) => {
    const seq = ++requestSeq
    set({ loading: true })
    try {
      const status = await api.gitStatus(workspaceId)
      if (seq !== requestSeq) return // 过期响应：已有更新的请求在途
      set({
        snapshot: status.isRepo ? (status as GitStatusDto & { isRepo: true }) : null,
        loading: false,
        error: null,
      })
    } catch (error) {
      if (seq !== requestSeq) return
      set({ loading: false, error: error instanceof ApiClientError || error instanceof Error ? error.message : String(error) })
    }
  },

  syncUpstream: async (api, workspaceId, phase) => {
    if (get().sync.phase) return // 同步进行中，忽略重复点击
    set({ sync: { phase, startedAt: Date.now(), error: null } })
    try {
      if (phase === 'push') await api.gitPush(workspaceId)
      else await api.gitPull(workspaceId)
    } catch (error) {
      const message = error instanceof ApiClientError || error instanceof Error ? error.message : String(error)
      set({ sync: { phase: null, startedAt: 0, error: message } })
    }
    if (get().sync.phase === phase) set({ sync: { phase: null, startedAt: 0, error: null } })
    // 成功或失败都重取快照，ahead/behind 立即归零或更新
    await get().refresh(api, workspaceId)
  },

  reset: () => {
    requestSeq++
    set({ snapshot: null, loading: false, error: null, sync: { phase: null, startedAt: 0, error: null } })
  },

  clearError: () => {
    if (get().error) set({ error: null })
  },

  clearSyncError: () => {
    if (get().sync.error) set({ sync: { ...get().sync, error: null } })
  },
}))

export interface GitBadge {
  code: string
  /** 目录聚合：其下变更文件数。 */
  count?: number
}

/**
 * path（正斜杠）→ 徽标映射；文件条目同时向每个祖先目录累计 count。
 * untracked 目录归并条目直接用自身徽标并计 count=1。
 */
export function badgeMapOf(changes: GitChangeDto[]): Map<string, GitBadge> {
  const map = new Map<string, GitBadge>()
  for (const change of changes) {
    const parts = change.path
    const selfPath = parts.join('/')
    if (change.kind === 'dir') {
      map.set(selfPath, { code: badgeCodeOf(change), count: 1 })
      continue
    }
    map.set(selfPath, { code: badgeCodeOf(change) })
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/')
      const existing = map.get(dirPath)
      if (existing) {
        if (existing.count !== undefined) existing.count++
      } else {
        map.set(dirPath, { code: '·', count: 1 })
      }
    }
  }
  return map
}

/** 变更条目对应的 FileKey。 */
export function changeKeyOf(workspaceId: string, change: GitChangeDto): string {
  return JSON.stringify([workspaceId, ...change.path])
}
