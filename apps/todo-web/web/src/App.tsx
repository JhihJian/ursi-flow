import { Workspace } from './components/Workspace'
import { TodoProvider } from './providers'

/** 独立入口：模块级上下文 + 本地分栏骨架。 */
export default function App() {
  return (
    <TodoProvider>
      <Workspace />
    </TodoProvider>
  )
}
