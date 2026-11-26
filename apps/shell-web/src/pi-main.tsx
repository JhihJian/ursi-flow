import { createRoot } from 'react-dom/client'
import { WorkspaceShell } from '@ursi/workspace-shell'
import { PI_MODULES, PI_PROFILES } from './pi-modules'
import './styles.css'

/**
 * Pi 控制台独立预览页：只装载 Pi 的三个模块（对话 / 会话 / 配置），
 * 不依赖 todo、fs、ssh 等其它模块，用来单独验收拆分后的 Pi 能力。
 *
 * 与完整工作台共用同一份接线（pi-modules.tsx），因此预览成立的行为
 * 在完整工作台里同样成立。
 */
function PiPreview() {
  return (
    <WorkspaceShell
      modules={PI_MODULES}
      profiles={PI_PROFILES}
      title="Pi 控制台"
      status="pi-chat · pi-sessions · pi-config"
      storageKey="ursi.pi-preview"
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点。')
createRoot(container).render(<PiPreview />)
