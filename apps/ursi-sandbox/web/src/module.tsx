/**
 * 沙箱模块工厂：把沙箱控制台作为一栏模块接入工作台外壳。
 *
 * - apiBase 由宿主注入（如 /sbx），缺省相对路径，独立部署也能直接跑。
 * - Panel 内部用 MemoryRouter 承载原有路由，实例列表与详情都在本栏内完成，
 *   不向外壳发布选中项（与 ssh 栏一致：模块自包含，工作区不需要额外视图）。
 */
import { MemoryRouter } from 'react-router'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { AppRoot } from './AppRoot'
import { SandboxConsole } from './App'
import { setApiBase } from './api-base'

export interface SandboxModuleOptions {
  /** 沙箱 Gateway 代理基准路径，如 /sbx。 */
  apiBase?: string
}

/** 沙箱模块展开态：完整控制台。 */
function SandboxPanel() {
  return (
    <MemoryRouter>
      <AppRoot>
        <SandboxConsole />
      </AppRoot>
    </MemoryRouter>
  )
}

export function createSandboxModule(options: SandboxModuleOptions = {}): WorkspaceModule {
  if (options.apiBase !== undefined) {
    setApiBase(options.apiBase)
  }
  return {
    id: 'sandbox',
    title: '沙箱',
    hideHeader: true,
    defaultSize: 560,
    minSize: 400,
    maxSize: 900,
    collapsedSize: 32,
    Panel: SandboxPanel,
    actions: [],
  }
}
