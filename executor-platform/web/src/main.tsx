import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import '@/app/styles.css'
import { initTheme } from '@/app/theme'
import { routes } from './routes'

initTheme()
const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
