import { createRoot } from 'react-dom/client'
import 'pi-agent-trajectory-viewer/style.css'
import './tokens.css'
import './theme.css'
import './styles.css'
import App from './App'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<App />)
