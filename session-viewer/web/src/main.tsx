import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'pi-agent-trajectory-viewer/style.css'
import './tokens.css'
import './theme.css'
import { SessionShell } from './SessionShell'
import './shell.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')

createRoot(container).render(
  <StrictMode>
    <SessionShell />
  </StrictMode>,
)
