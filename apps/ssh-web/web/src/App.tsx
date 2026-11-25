import { SshWorkspace } from './SshWorkspace'
import { useSshController } from './ssh-context'

/**
 * 独立入口：与工作区嵌入共用同一套组件与布局（左侧树侧栏 + 顶部会话标签栏 + 终端区），
 * controller 由 main.tsx 创建并经 Provider 注入，SshShell 自行加载连接列表。
 */
export default function App() {
  const controller = useSshController()
  return <SshWorkspace controller={controller} />
}
