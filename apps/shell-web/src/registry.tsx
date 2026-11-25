import type { WorkspaceModule, WorkspaceView } from '@ursi/workspace-shell'
import { createTodoModule } from '@ursi/todo-web/module'
import { createFsModule } from '@ursi/fs-web/module'
import { createPiWebModule } from './pi-web-panel/module'
import '@ursi/fs-web/module.css'
import './pi-web-panel/module.css'

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

/** 注册信息页不占栏，同样由标题栏按钮选中。 */
export const REGISTRY = { kind: 'app.registry', id: 'registry' } as const

/** 模块来源标注：包名或仓库内路径。id 撞上未登记来源时显式报错。 */
const SOURCES: Record<string, string> = {
  'todo': '@ursi/todo-web/module',
  'fs-web': '@ursi/fs-web/module',
  'pi-web': './pi-web-panel/module',
}

function SettingsView() {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Settings</h2>
      <p>全局设置占位：后续放服务地址、执行器修订、主题与快捷键。</p>
    </div>
  )
}

/** 注册信息从活的 modules 数组派生，不另存一份手工清单，避免漂移。 */
function RegistryView({ modules }: { modules: WorkspaceModule[] }) {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Registry</h2>
      <p>组合根登记的模块清单，栏序即数组顺序。</p>
      {modules.map((module) => (
        <div key={module.id} className="app-registry-item">
          <div className="app-registry-head">
            <span className="app-registry-title">{module.title}</span>
            <span className="app-registry-id">{module.id}</span>
          </div>
          <div className="app-registry-row">
            <dt>source</dt>
            <dd>{SOURCES[module.id] ?? '未登记来源'}</dd>
          </div>
          <div className="app-registry-row">
            <dt>selection</dt>
            <dd>{module.selection?.kind ?? '-'}</dd>
          </div>
          <div className="app-registry-row">
            <dt>actions</dt>
            <dd>
              {module.actions?.length
                ? module.actions.map((action) => action.label).join('、')
                : '-'}
            </dd>
          </div>
        </div>
      ))}
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
    createPiWebModule(),
  ]
  const views: WorkspaceView[] = [
    { kind: SETTINGS.kind, summary: () => 'Settings', Component: SettingsView },
    { kind: REGISTRY.kind, summary: () => 'Registry', Component: () => <RegistryView modules={modules} /> },
  ]
  if (import.meta.env.DEV) {
    assertRegistry(modules, views)
    for (const module of modules) {
      if (!SOURCES[module.id]) throw new Error(`[shell-web] 模块 ${module.id} 未登记来源`)
    }
  }
  return { modules, views }
}
