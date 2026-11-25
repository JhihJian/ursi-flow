import type { WorkspaceModule, WorkspaceView } from '@ursi/workspace-shell'
import { createTodoModule } from '@ursi/todo-web/module'
import { createFsModule } from '@ursi/fs-web/module'
import '@ursi/fs-web/module.css'

/**
 * 组合根：整个应用唯一允许出现宿主胶水代码的地方。
 * 模块清单、模块 options 注入、不占栏的视图都在这里显式声明；
 * 栏序就是数组顺序，不做运行时注册。
 */
export interface ShellRegistry {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
}

/** 设置页不占栏，注册成不占栏的视图，由标题栏按钮选中它。 */
export const SETTINGS = { kind: 'app.settings', id: 'settings' } as const

function SettingsView() {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Settings</h2>
      <p>全局设置占位：后续放服务地址、执行器修订、主题与快捷键。</p>
    </div>
  )
}

/** 开发期校验：id 与 selection.kind 全局唯一。撞名会在运行期被静默掩盖，这里显式报错。 */
function assertRegistry(modules: WorkspaceModule[], views: WorkspaceView[]): void {
  const ids = new Set<string>()
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`[shell-web] 模块 id 重复: ${module.id}`)
    ids.add(module.id)
  }
  const kinds = new Set<string>()
  for (const view of views) {
    if (kinds.has(view.kind)) throw new Error(`[shell-web] 视图 kind 重复: ${view.kind}`)
    kinds.add(view.kind)
  }
  for (const module of modules) {
    const kind = module.selection?.kind
    if (!kind) continue
    if (kinds.has(kind)) throw new Error(`[shell-web] selection kind 重复: ${kind}`)
    kinds.add(kind)
  }
}

export function buildRegistry(): ShellRegistry {
  const modules = [
    createTodoModule(),
    createFsModule({ apiBaseUrl: '/api/fs-web' }),
  ]
  const views: WorkspaceView[] = [
    { kind: SETTINGS.kind, summary: () => 'Settings', Component: SettingsView },
  ]
  if (import.meta.env.DEV) assertRegistry(modules, views)
  return { modules, views }
}
