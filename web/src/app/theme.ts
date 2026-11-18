import { create } from 'zustand'

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'ursi-flow:theme'

export interface ThemeState {
  mode: Theme
  setMode: (mode: Theme) => void
  toggleTheme: () => void
}

function applyTheme(mode: Theme) {
  const root = document.documentElement
  root.dataset.theme = mode
  // shadcn 的 darkMode: 'class' 需要 .dark，data-theme 供现有 token 与截图使用。
  root.classList.toggle('dark', mode === 'dark')
  root.style.colorScheme = mode
  useThemeStore.setState({ mode })
}

/** 应用级主题状态，读写 html 属性与 localStorage。 */
export const useThemeStore = create<ThemeState>((_set, get) => ({
  mode: 'light',
  setMode: (mode) => { applyTheme(mode) },
  toggleTheme: () => {
    const next: Theme = get().mode === 'light' ? 'dark' : 'light'
    applyTheme(next)
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* 存储受限时当前页面仍可切换。 */ }
  },
}))

let initialized = false

/** 挂载前同步执行，避免启动时闪一次主题过渡。 */
export function initTheme() {
  if (initialized) return
  initialized = true
  let saved: string | null = null
  try { saved = window.localStorage.getItem(THEME_STORAGE_KEY) } catch { /* 存储可能不可用。 */ }
  applyTheme(saved === 'dark' ? 'dark' : 'light')
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme(event.newValue === 'dark' ? 'dark' : 'light')
  })
}
