import { ref } from 'vue'

type Theme = 'light' | 'dark'
const storageKey = 'ursi-flow:theme'
export const theme = ref<Theme>('light')
let initialized = false

function applyTheme(value: Theme) {
  theme.value = value
  document.documentElement.dataset.theme = value
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.style.colorScheme = value
}

/** Call synchronously before mounting the app to avoid a theme transition on startup. */
export function initTheme() {
  if (initialized) return
  initialized = true
  let saved: string | null = null
  try { saved = window.localStorage.getItem(storageKey) } catch { /* Storage may be unavailable. */ }
  applyTheme(saved === 'dark' ? 'dark' : 'light')
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue === 'dark' ? 'dark' : 'light')
  })
}

export function toggleTheme() {
  applyTheme(theme.value === 'light' ? 'dark' : 'light')
  try { window.localStorage.setItem(storageKey, theme.value) } catch { /* The current tab still keeps the chosen theme. */ }
}
