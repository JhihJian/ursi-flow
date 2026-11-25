import type { ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { SshSidebar } from './SshSidebar'
import { SshWorkspaceArea } from './SshWorkspaceArea'
import { createSshController, SshModuleProvider, useSshStore, type SshControllerOptions } from './ssh-context'
import { STATE_LABEL } from './terminal-state'

/** 状态栏：激活终端的会话名与生命周期。 */
function SshStatus() {
  const terminals = useSshStore((state) => state.terminals)
  const activeTerminalKey = useSshStore((state) => state.activeTerminalKey)
  const activeTab = terminals.find((tab) => tab.key === activeTerminalKey)
  const label = activeTab?.tmuxSession ?? 'ssh-main'
  return (
    <span>
      SSH {activeTab ? `${label} · ` : ''}
      {STATE_LABEL[activeTab?.state ?? 'closed']}
      {terminals.length > 1 ? ` · 标签 ${terminals.length}` : ''}
    </span>
  )
}

export interface SshWebModuleOptions extends SshControllerOptions {}

/**
 * ssh 模块工厂。一个工厂一条 controller（API 通道 + store）实例：
 * apiBaseUrl、storageKey 都在这里注入，组件经 Context 取用，不设模块级单例。
 * 工作区一页一个实例；折叠即卸载，重开按会话重新 attach。
 */
export function createSshModule(options: SshWebModuleOptions = {}): WorkspaceModule {
  const controller = createSshController(options)

  const Provider = ({ children }: { children: ReactNode }) => (
    <SshModuleProvider controller={controller}>{children}</SshModuleProvider>
  )

  return {
    id: 'ssh',
    title: 'SSH',
    Provider,
    Sidebar: SshSidebar,
    Workspace: SshWorkspaceArea,
    context: { Status: SshStatus },
    sidebarDefaultSize: 320,
    sidebarMinSize: 160,
    sidebarMaxSize: 620,
    /** 折叠即卸载，远端 tmux 会话继续运行；重新展开后按会话重新 attach。 */
    keepMounted: false,
  }
}
