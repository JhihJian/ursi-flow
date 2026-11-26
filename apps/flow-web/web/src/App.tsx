import { useMemo } from 'react'
import { createFlowClient } from './api'
import { FlowSidebar } from './components/FlowSidebar'
import { FlowWorkspace } from './components/FlowWorkspace'
import { FlowProvider } from './store'

/** 独立入口：不依赖外壳，按同样的侧边栏 + 工作区两块布局渲染。 */
export default function App({ apiBaseUrl = '/api' }: { apiBaseUrl?: string }) {
  const client = useMemo(() => createFlowClient(apiBaseUrl), [apiBaseUrl])
  return (
    <FlowProvider client={client}>
      <div className="flow-standalone">
        <aside className="flow-standalone-side">
          <FlowSidebar collapsed={false} collapse={() => {}} expand={() => {}} />
        </aside>
        <main className="flow-standalone-main">
          <FlowWorkspace />
        </main>
      </div>
    </FlowProvider>
  )
}
