import { create } from 'zustand'
import { ApiError, api } from '../api/client'
import type { HomeSummary } from '../api/types'

/**
 * 全局唯一 store：home 选择 + 主题 + 页脚消息。
 * 分区数据由各 Section 组件自行拉取（写后回读），不进 store。
 */

const HOME_KEY = 'pi-manager.home'
const PRESET_KEY = 'pi-manager.presets'

/** 用户登记的 pi home 预设（路径 + 可选别名）。 */
export interface HomePreset {
  path: string
  label?: string
}

function loadHome(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? ''
  } catch {
    return ''
  }
}

function loadPresets(): HomePreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const path = (item as { path?: unknown }).path
      if (typeof path !== 'string' || !path.startsWith('/')) return []
      const label = (item as { label?: unknown }).label
      return [{ path, label: typeof label === 'string' && label ? label : undefined }]
    })
  } catch {
    return []
  }
}

function savePresets(presets: HomePreset[]): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets))
  } catch {
    /* ignore */
  }
}

export type FooterKind = 'idle' | 'busy' | 'ok' | 'error'

interface AppState {
  homePath: string
  homeValid: boolean | null
  homeChecking: boolean
  homeError: string | null
  footer: { kind: FooterKind; message: string }
  /** 已知 pi home（服务端扫描结果 + 登记的预设）。 */
  homes: HomeSummary[]
  homesLoading: boolean
  presets: HomePreset[]

  initHome: () => Promise<void>
  setHomePath: (path: string) => void
  confirmHome: (path: string) => Promise<boolean>
  /** 新增并切换到指定 home：成功返回 null，失败返回错误文本（不破坏当前视图）。 */
  addHome: (raw: string) => Promise<string | null>
  refreshHomes: () => Promise<void>
  addPreset: (path: string, label?: string) => Promise<void>
  removePreset: (path: string) => Promise<void>
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
  presets: loadPresets(),

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

  async addHome(raw) {
    const trimmed = raw.trim()
    if (!trimmed) return '请输入 pi home 路径'
    try {
      // 先校验再切换：无效路径不改动当前 home，只回报错误。
      const check = await api.homeCheck(trimmed)
      if (!get().homes.some((h) => h.path === check.home)) await get().addPreset(check.home)
      await get().confirmHome(check.home)
      return null
    } catch (error) {
      return describeError(error)
    }
  },

  async refreshHomes() {
    set({ homesLoading: true })
    try {
      const extra = get().presets.map((p) => p.path)
      const { homes } = await api.getHomes(extra)
      set({ homes, homesLoading: false })
    } catch (error) {
      set({ homesLoading: false, footer: { kind: 'error', message: `读取 pi home 列表失败：${describeError(error)}` } })
    }
  },

  async addPreset(path, label) {
    const trimmed = path.trim()
    if (!trimmed) return
    const existing = get().presets
    const next = existing.some((p) => p.path === trimmed)
      ? existing.map((p) => (p.path === trimmed ? { ...p, label: label ?? p.label } : p))
      : [...existing, { path: trimmed, label }]
    set({ presets: next })
    savePresets(next)
    await get().refreshHomes()
  },

  async removePreset(path) {
    const next = get().presets.filter((p) => p.path !== path)
    set({ presets: next })
    savePresets(next)
    await get().refreshHomes()
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
