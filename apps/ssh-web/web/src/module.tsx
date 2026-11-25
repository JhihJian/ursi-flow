import type { WorkspaceModule } from '@ursi/workspace-shell'
import { SshWorkspace } from './SshWorkspace'
import { createSshController, type SshControllerOptions } from './ssh-context'

/** 折叠窄条上显示的终端状态文案。 */
const STATE_LABEL: Record<string, string> = {
  connecting: '连接中',
  live: '已连接',
  ended: '已退出',
  error: '出错',
  closed: '未连接',
}

export interface SshWebModuleOptions extends SshControllerOptions {}

/**
 * ssh 模块工厂。一个工厂一条 controller（API 通道 + store）实例：
 * apiBaseUrl、storageKey 都在这里注入，组件经 Context 取用，不设模块级单例。
 * 工作区一页一个实例；折叠即卸载，重开按会话重新 attach。
 */
export function createSshModule(options: SshWebModuleOptions = {}): WorkspaceModule {
  const controller = createSshController(options)

  /** 折叠窄条摘要：当前会话名 + 终端生命周期。 */
  const useCollapsedSummary: WorkspaceModule['useCollapsedSummary'] = () => {
    const connections = controller.store((state) => state.connections)
    const activeId = controller.store((state) => state.activeId)
    const terminal = controller.store((state) => state.terminal)
    const terminalState = controller.store((state) => state.terminalState)
    const connection = connections.find((item) => item.id === activeId)
    const items: { label: string; value: string }[] = []
    if (terminal) items.push({ label: '会话', value: terminal.tmuxSession ?? 'ssh-main' })
    items.push({ label: '状态', value: STATE_LABEL[terminalState] ?? terminalState })
    return { title: connection?.name ?? 'SSH', items }
  }

  return {
    id: 'ssh',
    title: 'SSH',
    // 侧栏自带标题、终端区即内容，外壳不再画标题行。
    hideHeader: true,
    defaultSize: 560,
    minSize: 420,
    collapsedSize: 32,
    Panel: () => <SshWorkspace controller={controller} />,
    useCollapsedSummary,
  }
}
