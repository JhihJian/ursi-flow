import { createApp } from 'vue'
import { createPinia } from 'pinia'
import AppShell from '@/app/AppShell.vue'
import { createAppRouter } from '@/app/router'
import { initTheme } from '@/app/theme'
import '@/app/styles.css'

initTheme()

async function bootstrap() {
  if (import.meta.env.VITE_API_MODE !== 'live') {
    const { startMockApi } = await import('@/mocks')
    startMockApi()
  }
  createApp(AppShell).use(createPinia()).use(createAppRouter()).mount('#app')
}

void bootstrap()
