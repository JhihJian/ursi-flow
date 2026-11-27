import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'pi-agent-trajectory-viewer/style.css'
import '@ursi/directory-picker/style.css'
import './module.css'
import './standalone.css'
import { createPiModule } from './module'

/**
 * 独立入口：同一套模块与组件，不经过工作台外壳。
 * 三栏版面固定为「侧栏 + 工作区」，折叠控件由外壳负责，这里不出现。
 */
const pi = createPiModule({ storageKey: 'ursi.pi.standalone' })
const Provider = pi.Provider
const Sidebar = pi.Sidebar
const Workspace = pi.Workspace

function StandaloneApp() {
  const body = (
    <div className="pi-solo">
      <aside className="pi-solo-sidebar">
        <Sidebar collapsed={false} collapse={() => undefined} expand={() => undefined} />
      </aside>
      <main className="pi-solo-workspace">
        <Workspace />
      </main>
    </div>
  )
  return Provider ? <Provider>{body}</Provider> : body
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StandaloneApp />
  </StrictMode>,
)
