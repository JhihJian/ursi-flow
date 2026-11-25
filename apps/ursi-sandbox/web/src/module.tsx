/**
 * 沙箱模块工厂：侧边栏放模块导航与实例列表，工作区放路由内容。
 *
 * - apiBase 由宿主注入（如 /sbx），缺省相对路径，独立部署也能直接跑。
 * - Provider 提供 MemoryRouter 与共享数据（配置、实例列表、筛选），
 *   侧边栏与工作区读同一份，不重复请求。
 */
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { setApiBase } from './api-base'
import { SandboxDataProvider, statuses, useSandboxData } from './common'
import { SandboxSidebar } from './SandboxSidebar'
import { SandboxWorkspace } from './SandboxWorkspace'

export interface SandboxModuleOptions {
  /** 沙箱 Gateway 代理基准路径，如 /sbx。 */
  apiBase?: string
}

function SandboxStatus() {
  const { config, list } = useSandboxData()
  const rows = list.value ?? []
  const running = rows.filter((row) => row.status === 'running').length
  const mode = config.value ? (config.value.manage ? '管理员' : '只读') : 'Gateway'
  return (
    <span>
      沙箱 {rows.length}
      {running > 0 ? ` · ${statuses.running} ${running}` : ''} · {mode}
    </span>
  )
}

export function createSandboxModule(options: SandboxModuleOptions = {}): WorkspaceModule {
  if (options.apiBase !== undefined) {
    setApiBase(options.apiBase)
  }

  const Provider = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <SandboxDataProvider>{children}</SandboxDataProvider>
    </MemoryRouter>
  )

  return {
    id: 'sandbox',
    title: '沙箱',
    Provider,
    Sidebar: SandboxSidebar,
    Workspace: SandboxWorkspace,
    context: { Status: SandboxStatus },
    sidebarDefaultSize: 360,
    sidebarMinSize: 200,
    sidebarMaxSize: 680,
    actions: [],
  }
}
