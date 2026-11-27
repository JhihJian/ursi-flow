import type { WorkspaceModule, WorkspaceProfile, WorkspaceView } from '@ursi/workspace-shell'
import { ProfilesEditor, createProfilesStore, useProfiles } from '@ursi/workspace-shell'
import { createTodoModule } from '@ursi/todo-web/module'
import { createFlowModule } from '@ursi/flow-web/module'
import { createFsModule } from '@ursi/fs-web/module'
import { createSshModule } from '@ursi/ssh-web/module'
import { createSandboxModule } from '@ursi/sandbox-web/module'
import { createPiModule } from '@ursi/pi-web/module'
import '@ursi/directory-picker/style.css'
import '@ursi/fs-web/module.css'
import '@ursi/ssh-web/module.css'
import '@ursi/sandbox-web/module.css'
import '@ursi/pi-web/module.css'
import '@ursi/flow-web/styles.css'
// 轨迹组件库的样式是全局前缀类（dsw- / trajectory-*），在这里引一次即可。
import 'pi-agent-trajectory-viewer/style.css'

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

/** profile 配置页：定义有哪些 profile、每个启用哪些模块。 */
export const PROFILES = { kind: 'app.profiles', id: 'profiles' } as const

/** 注册信息页同上。 */
export const REGISTRY = { kind: 'app.registry', id: 'registry' } as const

/** 宿主与外壳共用的存储前缀：激活的 profile、各 profile 的展开状态、自定义 profile 都在它下面。 */
export const STORAGE_KEY = 'ursi.workspace'

/** 模块来源标注：包名或仓库内路径。id 撞上未登记来源时显式报错。 */
const SOURCES: Record<string, string> = {
  'todo': '@ursi/todo-web/module',
  'fs-web': '@ursi/fs-web/module',
  'ssh': '@ursi/ssh-web/module',
  'sandbox': '@ursi/sandbox-web/module',
  'flow': '@ursi/flow-web/module',
  'pi': '@ursi/pi-web/module',
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
function RegistryView({
  modules,
  profiles,
  wires,
}: {
  modules: WorkspaceModule[]
  profiles: WorkspaceProfile[]
  wires: Array<{ from: string; to: string; capability: string }>
}) {
  return (
    <div className="app-page">
      <h2 className="app-page-title">Registry</h2>
      <p>组合根登记的模块。profile 只决定启用哪些模块与顺序，布局由外壳固定。</p>
      {wires.map((wire) => (
        <div key={`${wire.from}:${wire.to}`} className="app-registry-item">
          <div className="app-registry-head">
            <span className="app-registry-title">跨模块依赖</span>
            <span className="app-registry-id">
              {wire.from} → {wire.to}
            </span>
          </div>
          <div className="app-registry-row">
            <dt>capability</dt>
            <dd>{wire.capability}</dd>
          </div>
        </div>
      ))}
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
                折叠条 {module.collapsedSidebarSize ?? 32}px · 最小宽度 {module.minSidebarSize ?? 200}px ·
                默认{module.defaultExpanded ? '展开' : '折叠'} · 工作区
                {module.keepMounted ? '常驻' : '折叠即卸载'}
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

/**
 * 组合根是唯一同时看见多个模块的地方，跨模块的边在这里显式接线：
 * 用 import 连边，删掉文件模块会直接编译失败，不留运行期才发现的悬空调用。
 */
/** ssh 先建：它的 commands 要注入给 fs，所以顺序上必须在 files 之前。 */
const ssh = createSshModule({ apiBaseUrl: '/api/ssh-web' })

/**
 * fs 的远程目录能力由 ssh 提供：设备清单给选目录器，终端给目录右键。
 * fs 不 import ssh，只接两个函数；ssh 被移除时这里编译失败。
 */
const files = createFsModule({
  apiBaseUrl: '/api/fs-web',
  host: {
    devices: ssh.commands.listDevices,
    openTerminal: ssh.commands.openTerminal,
  },
})

/** Pi Web 是一个模块：配置、对话、会话共用同一份 home 与会话实体。 */
const piModule = createPiModule({ apiBaseUrl: '/api/pi', storageKey: 'ursi.pi' })

/** 工厂在模块级只调一次，保持组件引用稳定，避免宿主重渲染时重挂模块内部状态。 */
const MODULES: WorkspaceModule[] = [
  createTodoModule({ openRootInFiles: files.commands.openRoot }),
  createFlowModule({
    apiBaseUrl: '/api/flow-web',
    openRootInFiles: files.commands.openRoot,
  }),
  files,
  ssh,
  createSandboxModule({ apiBase: '/sbx' }),
  piModule,
]

/** 跨模块依赖的说明，Registry 页直接展示，避免边藏在代码里。 */
const WIRES: Array<{ from: string; to: string; capability: string }> = [
  { from: 'todo', to: 'fs-web', capability: 'openRootInFiles → fs.commands.openRoot' },
  { from: 'flow', to: 'fs-web', capability: 'openRootInFiles → fs.commands.openRoot' },
  { from: 'ssh', to: 'fs-web', capability: 'host.devices / host.openTerminal → ssh.commands' },
]

/**
 * 页面 profile：只声明启用模块与顺序。
 * 这里的默认值在首次打开时落盘一次，之后由标题栏的 Profiles 页编辑，
 * 侧边栏展开状态、每节高度与工作区列宽按 profile 隔离持久化。
 */
const DEFAULT_PROFILES: WorkspaceProfile[] = [
  { id: 'work', title: '工作', modules: ['todo', 'fs-web', 'ssh'] },
  { id: 'terminal', title: '终端', modules: ['ssh', 'fs-web'] },
  { id: 'sandbox', title: '沙箱', modules: ['sandbox', 'ssh'] },
  { id: 'flow', title: 'Flow', modules: ['flow', 'fs-web'] },
  { id: 'pi', title: 'Pi', modules: ['pi', 'fs-web'] },
]

/** profile 配置存在这里；编辑页与外壳读同一份快照，改配置不会重建编辑组件本身。 */
const PROFILES_STORE = createProfilesStore({ storageKey: STORAGE_KEY, defaults: DEFAULT_PROFILES })

function ProfilesPage() {
  return <ProfilesEditor modules={MODULES} store={PROFILES_STORE} />
}

/** 注册信息从活的 modules 与 profile 快照派生，不另存一份手工清单，避免漂移。 */
function RegistryPage() {
  const profiles = useProfiles(PROFILES_STORE)
  return <RegistryView modules={MODULES} profiles={profiles} wires={WIRES} />
}

/** 宿主页面在模块级登记，组件引用稳定；改 profile 不会让当前页面被重挂。 */
const VIEWS: WorkspaceView[] = [
  { kind: SETTINGS.kind, summary: () => 'Settings', Component: SettingsView },
  { kind: PROFILES.kind, summary: () => 'Profiles', Component: ProfilesPage },
  { kind: REGISTRY.kind, summary: () => 'Registry', Component: RegistryPage },
]

/** 组合根装配：模块与页面只建一次，profile 编辑与切换由外壳负责。 */
export function useShellRegistry(): ShellRegistry {
  const profiles = useProfiles(PROFILES_STORE)
  if (import.meta.env.DEV) assertRegistry(MODULES, VIEWS)
  return { modules: MODULES, views: VIEWS, profiles }
}
