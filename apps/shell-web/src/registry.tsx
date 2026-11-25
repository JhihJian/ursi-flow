import { useMemo } from 'react'
import type { WorkspaceModule, WorkspaceProfile, WorkspaceView } from '@ursi/workspace-shell'
import { createTodoModule } from '@ursi/todo-web/module'
import { createFsModule } from '@ursi/fs-web/module'
import { createSshModule } from '@ursi/ssh-web/module'
import { createSandboxModule } from '@ursi/sandbox-web/module'
import { createPiWebModule } from './pi-web-panel/module'
import '@ursi/fs-web/module.css'
import '@ursi/ssh-web/module.css'
import '@ursi/sandbox-web/module.css'
import './pi-web-panel/module.css'

/**
 * 组合根：整个应用唯一允许出现宿主胶水代码的地方。
 * 模块清单、模块 options 注入、不占侧边栏的宿主页面都在这里显式声明；
 * profile 只决定启用哪些模块以及顺序，布局骨架由外壳固定。
 */
export interface ShellRegistry {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  profiles: WorkspaceProfile[]
}

/** 设置页不占侧边栏，由标题栏按钮选中，占用整个工作区。 */
export const SETTINGS = { kind: 'app.settings', id: 'settings' } as const

/** 注册信息页同上。 */
export const REGISTRY = { kind: 'app.registry', id: 'registry' } as const

/** 模块来源标注：包名或仓库内路径。id 撞上未登记来源时显式报错。 */
const SOURCES: Record<string, string> = {
  'todo': '@ursi/todo-web/module',
  'fs-web': '@ursi/fs-web/module',
  'ssh': '@ursi/ssh-web/module',
  'sandbox': '@ursi/sandbox-web/module',
  'pi-web': './pi-web-panel/module',
}

function SettingsView() {
  return (
    <div className="app-page">
      <h2 className="app-page-title">Settings</h2>
      <p>全局设置占位：后续放服务地址、执行器修订、主题与快捷键。</p>
    </div>
  )
}

/** 注册信息从活的 modules 数组派生，不另存一份手工清单，避免漂移。 */
function RegistryView({ modules, profiles }: { modules: WorkspaceModule[]; profiles: WorkspaceProfile[] }) {
  return (
    <div className="app-page">
      <h2 className="app-page-title">Registry</h2>
      <p>组合根登记的模块。profile 只决定启用哪些模块与顺序，布局由外壳固定。</p>
      {modules.map((module) => {
        const enabledIn = profiles
          .filter((profile) => profile.modules.includes(module.id))
          .map((profile) => profile.title)
          .join('、')
        return (
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
              <dd>{module.context.kind ?? '-'}</dd>
            </div>
            <div className="app-registry-row">
              <dt>statusbar</dt>
              <dd>{module.context.Status ? '组件' : module.context.summary ? '摘要' : '-'}</dd>
            </div>
            <div className="app-registry-row">
              <dt>sidebar</dt>
              <dd>
                default {module.sidebarDefaultSize ?? 260} · min {module.sidebarMinSize ?? 120} ·
                max {module.sidebarMaxSize ?? 620}
              </dd>
            </div>
            <div className="app-registry-row">
              <dt>actions</dt>
              <dd>
                {module.actions?.length
                  ? module.actions.map((action) => action.label).join('、')
                  : '-'}
              </dd>
            </div>
            <div className="app-registry-row">
              <dt>profiles</dt>
              <dd>{enabledIn || '-'}</dd>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 开发期校验：模块 id 与 context.kind 全局唯一。 */
function assertRegistry(modules: WorkspaceModule[], views: WorkspaceView[]): void {
  const ids = new Set<string>()
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`[shell-web] 模块 id 重复: ${module.id}`)
    ids.add(module.id)
    if (!SOURCES[module.id]) throw new Error(`[shell-web] 模块 ${module.id} 未登记来源`)
  }
  const kinds = new Set<string>()
  for (const view of views) {
    if (kinds.has(view.kind)) throw new Error(`[shell-web] 页面 kind 重复: ${view.kind}`)
    kinds.add(view.kind)
  }
  for (const module of modules) {
    const kind = module.context.kind
    if (!kind) continue
    if (kinds.has(kind)) throw new Error(`[shell-web] context.kind 重复: ${kind}`)
    kinds.add(kind)
  }
}

/** 工厂在模块级只调一次，保持组件引用稳定，避免宿主重渲染时重挂模块内部状态。 */
const MODULES: WorkspaceModule[] = [
  createTodoModule(),
  createFsModule({ apiBaseUrl: '/api/fs-web' }),
  createSshModule({ apiBaseUrl: '/api/ssh-web' }),
  createSandboxModule({ apiBase: '/sbx' }),
  createPiWebModule(),
]

/**
 * 页面 profile：只声明启用模块与顺序。
 * 侧边栏展开状态、每节高度与工作区列宽按 profile 隔离持久化。
 */
const PROFILES: WorkspaceProfile[] = [
  { id: 'work', title: '工作', modules: ['todo', 'fs-web', 'ssh'] },
  { id: 'terminal', title: '终端', modules: ['ssh', 'fs-web'] },
  { id: 'sandbox', title: '沙箱', modules: ['sandbox', 'ssh'] },
  { id: 'assistant', title: '助手', modules: ['pi-web', 'fs-web'] },
]

/** 组合根装配：模块与页面只建一次，profile 切换由外壳负责。 */
export function useShellRegistry(): ShellRegistry {
  const views = useMemo<WorkspaceView[]>(
    () => [
      { kind: SETTINGS.kind, summary: () => 'Settings', Component: SettingsView },
      {
        kind: REGISTRY.kind,
        summary: () => 'Registry',
        Component: () => <RegistryView modules={MODULES} profiles={PROFILES} />,
      },
    ],
    [],
  )

  if (import.meta.env.DEV) assertRegistry(MODULES, views)

  return { modules: MODULES, views, profiles: PROFILES }
}
