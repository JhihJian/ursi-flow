import { create } from 'zustand'

export type Theme = 'light' | 'dark'
/** 主色调：默认品牌紫或黑白灰。明暗与主色调互相独立。 */
export type Palette = 'color' | 'mono'

export const THEME_STORAGE_KEY = 'ursi-flow:theme'
export const PALETTE_STORAGE_KEY = 'ursi-flow:palette'

export interface ThemeState {
  mode: Theme
  palette: Palette
  setMode: (mode: Theme) => void
  toggleTheme: () => void
  setPalette: (palette: Palette) => void
  togglePalette: () => void
}

function readMode(value: string | null): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

function readPalette(value: string | null): Palette {
  return value === 'mono' ? 'mono' : 'color'
}

function persist(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* 存储受限时当前页面仍可切换。 */ }
}

function savedMode(): Theme {
  try { return readMode(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { return 'light' }
}

function savedPalette(): Palette {
  try { return readPalette(window.localStorage.getItem(PALETTE_STORAGE_KEY)) } catch { return 'color' }
}

function applyAppearance(mode: Theme, palette: Palette) {
  const root = document.documentElement
  root.dataset.theme = mode
  root.dataset.palette = palette
  // shadcn 的 darkMode: 'class' 需要 .dark，data-theme 供现有 token 与截图使用。
  root.classList.toggle('dark', mode === 'dark')
  root.style.colorScheme = mode
  useThemeStore.setState({ mode, palette })
}

/** 应用级外观状态：明暗与主色调各自独立，读写 html 属性与 localStorage。 */
export const useThemeStore = create<ThemeState>((_set, get) => ({
  mode: 'light',
  palette: 'color',
  setMode: (mode) => {
    applyAppearance(mode, get().palette)
    persist(THEME_STORAGE_KEY, mode)
  },
  toggleTheme: () => {
    get().setMode(get().mode === 'light' ? 'dark' : 'light')
  },
  setPalette: (palette) => {
    applyAppearance(get().mode, palette)
    persist(PALETTE_STORAGE_KEY, palette)
  },
  togglePalette: () => {
    get().setPalette(get().palette === 'color' ? 'mono' : 'color')
  },
}))

let initialized = false

/** 挂载前同步执行，避免启动时闪一次主题过渡。 */
export function initTheme() {
  if (initialized) return
  initialized = true
  applyAppearance(savedMode(), savedPalette())
  window.addEventListener('storage', (event) => {
    if (event.key === null) {
      applyAppearance(savedMode(), savedPalette())
    } else if (event.key === THEME_STORAGE_KEY) {
      applyAppearance(readMode(event.newValue), useThemeStore.getState().palette)
    } else if (event.key === PALETTE_STORAGE_KEY) {
      applyAppearance(useThemeStore.getState().mode, readPalette(event.newValue))
    }
  })
}
