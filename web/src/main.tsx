import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'

import { createAppRouter } from '@/app/router'
import { initTheme } from '@/app/theme'
import '@/app/styles.css'

initTheme()

async function bootstrap() {
  if (import.meta.env.VITE_API_MODE !== 'live') {
    const { startMockApi } = await import('@/mocks')
    startMockApi()
  }
  const container = document.getElementById('root')
  if (!container) throw new Error('缺少 #root 挂载点。')
  createRoot(container).render(<RouterProvider router={createAppRouter()} />)
}

void bootstrap()
