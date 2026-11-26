import { createRoot } from 'react-dom/client'
import 'pi-agent-trajectory-viewer/style.css'
import './module.css'
import './standalone.css'
import { StandaloneApp } from './StandaloneApp'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<StandaloneApp />)
