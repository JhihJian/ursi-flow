import { create } from 'zustand'
import { ApiError, api } from './views/config/api/client'
import type { HomeCreateInput, HomeSummary } from './views/config/api/types'

/**
 * 全局唯一 store：home 选择 + 主题 + 页脚消息。
 * 分区数据由各 Section 组件自行拉取（写后回读），不进 store。
 */

const HOME_KEY = 'pi-manager.home'

/** 当前 home 记在 localStorage：它是"我用哪个 home"的偏好，不是清单本身。 */
function loadHome(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? ''
  } catch {
    return ''
  }
}

export type FooterKind = 'idle' | 'busy' | 'ok' | 'error'

interface AppState {
  homePath: string
  homeValid: boolean | null
  homeChecking: boolean
  homeError: string | null
  footer: { kind: FooterKind; message: string }
  /** pi home 清单：服务端注册表 + 自动发现。 */
  homes: HomeSummary[]
  homesLoading: boolean

  initHome: () => Promise<void>
  setHomePath: (path: string) => void
  confirmHome: (path: string) => Promise<boolean>
  refreshHomes: () => Promise<void>
  /** 新增 pi home（登记 / 初始化 / 复制）并切换过去：成功返回 null，失败返回错误文本。 */
  createHome: (input: HomeCreateInput) => Promise<string | null>
  /** 改名 / 编辑说明；只动清单元数据。 */
  updateHome: (id: string, patch: { name?: string; description?: string }) => Promise<string | null>
  /** 从清单移除（不删目录）；移除当前 home 时自动切到第一个可用项。 */
  removeHome: (id: string) => Promise<string | null>
  setFooter: (kind: FooterKind, message: string) => void
  clearFooter: () => void
  /** 包装写操作：footer 显示忙碌/成功/失败，返回是否成功。 */
  runWrite: (label: string, fn: () => Promise<void>) => Promise<boolean>
}

export const useAppStore = create<AppState>((set, get) => ({
  homePath: loadHome(),
  homeValid: null,
  homeChecking: false,
  homeError: null,
  footer: { kind: 'idle', message: '' },
  homes: [],
  homesLoading: false,

  async initHome() {
    void get().refreshHomes()
    const current = get().homePath
    if (current) {
      await get().confirmHome(current)
      return
    }
    try {
      const { default: fallback } = await api.homeDefaults()
      if (fallback) await get().confirmHome(fallback)
      else set({ homeError: '没有找到默认 pi home，请手动指定路径' })
    } catch (error) {
      set({ homeError: describeError(error) })
    }
  },

  async refreshHomes() {
    set({ homesLoading: true })
    try {
      const { homes } = await api.getHomes()
      set({ homes, homesLoading: false })
    } catch (error) {
      set({ homesLoading: false, footer: { kind: 'error', message: `读取 pi home 列表失败：${describeError(error)}` } })
    }
  },

  async createHome(input) {
    try {
      const { home } = await api.createHome(input)
      await get().refreshHomes()
      await get().confirmHome(home.path)
      return null
    } catch (error) {
      return describeError(error)
    }
  },

  async updateHome(id, patch) {
    try {
      await api.updateHome(id, patch)
      await get().refreshHomes()
      return null
    } catch (error) {
      return describeError(error)
    }
  },

  async removeHome(id) {
    try {
      const removed = get().homes.find((h) => h.id === id)
      await api.removeHome(id)
      await get().refreshHomes()
      // 移除的正是当前 home 时切到第一个可用项，避免停在失效条目上。
      if (removed && removed.path === get().homePath) {
        const next = get().homes.find((h) => h.valid)
        if (next) await get().confirmHome(next.path)
      }
      return null
    } catch (error) {
      return describeError(error)
    }
  },

  setHomePath(path: string) {
    set({ homePath: path, homeValid: null, homeError: null })
  },

  async confirmHome(path: string) {
    const trimmed = path.trim()
    if (!trimmed) return false
    set({ homeChecking: true, homeError: null })
    try {
      const check = await api.homeCheck(trimmed)
      // 服务端展开 ~ 后回传真实路径，统一存绝对路径。
      const resolved = check.home || trimmed
      try {
        localStorage.setItem(HOME_KEY, resolved)
      } catch {
        /* ignore */
      }
      set({ homePath: resolved, homeValid: check.valid, homeChecking: false })
      void get().refreshHomes()
      return true
    } catch (error) {
      set({ homeChecking: false, homeValid: false, homeError: describeError(error) })
      return false
    }
  },

  setFooter(kind, message) {
    set({ footer: { kind, message } })
  },

  clearFooter() {
    set({ footer: { kind: 'idle', message: '' } })
  },

  async runWrite(label, fn) {
    set({ footer: { kind: 'busy', message: `${label}…` } })
    try {
      await fn()
      set({ footer: { kind: 'ok', message: `${label}完成` } })
      return true
    } catch (error) {
      set({ footer: { kind: 'error', message: `${label}失败：${describeError(error)}` } })
      return false
    }
  },
}))

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
