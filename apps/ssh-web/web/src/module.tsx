import type { ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { SshSidebar } from './SshSidebar'
import { SshWorkspaceArea } from './SshWorkspaceArea'
import { SshStatus } from './components/SshStatus'
import { createSshController, SshModuleProvider, type SshControllerOptions } from './ssh-context'

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
    /** 折叠即卸载，远端 tmux 会话继续运行；重新展开后按会话重新 attach。 */
    keepMounted: false,
  }
}
