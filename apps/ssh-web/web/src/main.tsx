import { createRoot } from 'react-dom/client'
import App from './App'
import './module.css'
import './standalone.css'
import { createSshController } from './ssh-context'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')

// 独立入口自建 controller：API 走同源 /api（vite 代理到 8091）。
const controller = createSshController({ apiBaseUrl: '/api' })

createRoot(container).render(<App controller={controller} />)
