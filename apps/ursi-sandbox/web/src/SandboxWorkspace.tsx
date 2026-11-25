import { AppRoot } from './AppRoot'
import { SandboxRoutes } from './App'

/** 沙箱工作区：路由内容占满，不含模块标题与导航。 */
export function SandboxWorkspace() {
  return (
    <AppRoot>
      <div className="sbx-workspace-content">
        <SandboxRoutes />
      </div>
    </AppRoot>
  )
}
