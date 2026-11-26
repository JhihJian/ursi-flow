import { createRoot } from 'react-dom/client'
import { ChatProvider } from './chat-context'
import { ChatSidebar } from './components/ChatSidebar'
import { ChatWorkspace } from './components/ChatWorkspace'
import 'pi-agent-trajectory-viewer/style.css'
import './module.css'

/** 独立入口：同一对组件，不经过工作台外壳。接口前缀默认同源。 */
function StandaloneApp() {
  return (
    <ChatProvider options={{ storageKey: 'pi-chat-standalone' }}>
      <div style={{ display: 'flex', height: '100dvh', minHeight: 0 }}>
        <div style={{ width: 340, flex: 'none', minHeight: 0, overflow: 'hidden', borderRight: '1px solid #e2ddd4' }}>
          <ChatSidebar collapsed={false} collapse={() => undefined} expand={() => undefined} />
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <ChatWorkspace />
        </div>
      </div>
    </ChatProvider>
  )
}

createRoot(document.getElementById('root')!).render(<StandaloneApp />)
