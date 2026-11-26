import { MuteButton } from './components/MuteButton'
import { Workspace } from './components/Workspace'
import { TodoProvider } from './providers'

/** 独立入口：模块级上下文 + 本地分栏骨架 + 右下角静音按钮。 */
export default function App() {
  return (
    <TodoProvider>
      <Workspace />
      <MuteButton />
    </TodoProvider>
  )
}
