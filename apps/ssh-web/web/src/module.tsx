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

  /** 折叠窄条摘要：激活标签的会话名 + 终端生命周期 + 打开数。 */
  const useCollapsedSummary: WorkspaceModule['useCollapsedSummary'] = () => {
    const connections = controller.store((state) => state.connections)
    const terminals = controller.store((state) => state.terminals)
    const activeTerminalKey = controller.store((state) => state.activeTerminalKey)
    const activeTab = terminals.find((tab) => tab.key === activeTerminalKey)
    const connection = activeTab
      ? connections.find((item) => item.id === activeTab.connectionId)
      : undefined
    const items: { label: string; value: string }[] = []
    if (activeTab) items.push({ label: '会话', value: activeTab.tmuxSession ?? 'ssh-main' })
    items.push({ label: '状态', value: STATE_LABEL[activeTab?.state ?? 'closed'] ?? '未连接' })
    if (terminals.length > 1) items.push({ label: '标签', value: String(terminals.length) })
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
