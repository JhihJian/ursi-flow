import { create } from 'zustand'
import { ApiError, api } from '../api/client'

/**
 * 全局唯一 store：home 选择 + 主题 + 页脚消息。
 * 分区数据由各 Section 组件自行拉取（写后回读），不进 store。
 */

export type ThemeMode = 'dark' | 'light'

const HOME_KEY = 'pi-manager.home'
const THEME_KEY = 'pi-manager.theme'

function loadHome(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? ''
  } catch {
    return ''
  }
}

function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return 'dark'
}

export type FooterKind = 'idle' | 'busy' | 'ok' | 'error'

interface AppState {
  homePath: string
  homeValid: boolean | null
  homeChecking: boolean
  homeError: string | null
  theme: ThemeMode
  footer: { kind: FooterKind; message: string }

  initHome: () => Promise<void>
  setHomePath: (path: string) => void
  confirmHome: (path: string) => Promise<boolean>
  toggleTheme: () => void
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
  theme: loadTheme(),
  footer: { kind: 'idle', message: '' },

  async initHome() {
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
      return true
    } catch (error) {
      set({ homeChecking: false, homeValid: false, homeError: describeError(error) })
      return false
    }
  },

  toggleTheme() {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
    set({ theme: next })
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
