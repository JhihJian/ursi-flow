import { createRoot } from 'react-dom/client'
import { ChatProvider } from './chat-context'
import { ChatSidebar } from './components/ChatSidebar'
import { ChatWorkspace } from './components/ChatWorkspace'
import 'pi-agent-trajectory-viewer/style.css'
import './module.css'
import './standalone.css'

/**
 * 独立入口：同一对组件，不经过工作台外壳。接口前缀默认同源。
 * 版面是固定的两栏，折叠由外壳负责，这里不出折叠控件。
 */
function StandaloneApp() {
  return (
    <ChatProvider options={{ storageKey: 'pi-chat-standalone' }}>
      <div className="solo">
        <aside className="solo-sidebar">
          <ChatSidebar collapsed={false} collapse={() => undefined} expand={() => undefined} />
        </aside>
        <main className="solo-workspace">
          <ChatWorkspace />
        </main>
      </div>
    </ChatProvider>
  )
}

createRoot(document.getElementById('root')!).render(<StandaloneApp />)
