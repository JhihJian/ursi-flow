import type { ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { SshSidebar } from './SshSidebar'
import { SshWorkspaceArea } from './SshWorkspaceArea'
import { SshStatus } from './components/SshStatus'
import { createSshController, SshModuleProvider, type SshControllerOptions } from './ssh-context'

export interface SshWebModuleOptions extends SshControllerOptions {}

/**
 * ssh 模块对外提供的具名能力：由工厂导出，交给组合根注入给需要的模块（如 fs-web）。
 * 调用方只认识设备名与设备内路径这类普通值，不需要知道 ssh 的连接 id、tmux 会话或 API 形状。
 */
export interface SshCommands {
  /** 设备清单：位置契约里的设备名就是连接 name。按名称排序。 */
  listDevices: () => Promise<Array<{ device: string; label: string }>>
  /** 在指定设备的指定目录打开终端：已打开则激活，否则新开一个标签并 cd 到 cwd。 */
  openTerminal: (target: { device: string; cwd: string }) => Promise<void>
}

/**
 * ssh 模块工厂。一个工厂一条 controller（API 通道 + store）实例：
 * apiBaseUrl、storageKey 都在这里注入，组件经 Context 取用，不设模块级单例。
 * 工作区一页一个实例；折叠即卸载，重开按会话重新 attach。
 */
export function createSshModule(
  options: SshWebModuleOptions = {},
): WorkspaceModule & { commands: SshCommands } {
  const controller = createSshController(options)

  /**
   * 命令直接走工厂闭包里的 controller（api + store），不依赖 Provider 是否已挂载：
   * ssh 未在当前 profile 里展开时，跨模块调用依然要能工作。
   */
  const commands: SshCommands = {
    listDevices: async () => {
      const { connections } = await controller.api.listConnections()
      // 按码位序排：设备名只有 [A-Za-z0-9._-]，码位序在各运行环境一致，不受 locale 影响。
      return connections
        .map((connection) => ({ device: connection.name, label: connection.name }))
        .sort((left, right) => (left.device < right.device ? -1 : left.device > right.device ? 1 : 0))
    },

    openTerminal: async ({ device, cwd }) => {
      // Provider 未挂载时 store 里还没有连接列表，先拉一次；已拉过就不再请求。
      const store = controller.store
      if (store.getState().connections.length === 0) await store.getState().loadConnections()
      const connection = store.getState().connections.find((item) => item.name === device)
      if (!connection) throw new Error(`ssh-web 里没有名为 ${device} 的连接`)
      store.getState().openTerminal(connection.id, null, cwd)
    },
  }

  const Provider = ({ children }: { children: ReactNode }) => (
    <SshModuleProvider controller={controller}>{children}</SshModuleProvider>
  )

  return {
    commands,
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
