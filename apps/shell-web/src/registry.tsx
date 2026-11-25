import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
 * 模块清单、模块 options 注入、不占栏的视图都在这里显式声明；
 * 栏序就是数组顺序，不做运行时注册。
 */
export interface ShellRegistry {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  profiles: WorkspaceProfile[]
}

/** 设置页不占栏，注册成不占栏的视图，由标题栏按钮选中它。 */
export const SETTINGS = { kind: 'app.settings', id: 'settings' } as const

/** 注册信息页不占栏，同样由标题栏按钮选中。 */
export const REGISTRY = { kind: 'app.registry', id: 'registry' } as const

/** 模块来源标注：包名或仓库内路径。id 撞上未登记来源时显式报错。 */
const SOURCES: Record<string, string> = {
  'todo': '@ursi/todo-web/module',
  'fs-web': '@ursi/fs-web/module',
  'ssh': '@ursi/ssh-web/module',
  'sandbox': '@ursi/sandbox-web/module',
  'pi-web': './pi-web-panel/module',
}

/** 外壳对未声明字段的兜底值，与 workspace-shell 的 shell.tsx 保持一致。 */
const SHELL_MIN = 240
const SHELL_MAX = 760
const DEFAULT_COLLAPSED = 32

/** 栏宽约束覆盖：Registry 页面调整，落在本地，随装配生效。 */
export interface ModuleConstraints {
  minSize?: number
  maxSize?: number
}
type Overrides = Record<string, ModuleConstraints>

const OVERRIDES_KEY = 'ursi.shell-web.registry-overrides'

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {}
  } catch {
    return {}
  }
}

function SettingsView() {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Settings</h2>
      <p>全局设置占位：后续放服务地址、执行器修订、主题与快捷键。</p>
    </div>
  )
}

/** 单个约束输入：草稿态编辑，失焦或回车提交，非法值回退并提示。 */
function ConstraintField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: number
  placeholder: string
  onCommit: (raw: string) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => onCommit(draft.trim())
  return (
    <label className="app-constraint">
      <span className="app-constraint-label">{label}</span>
      <input
        type="number"
        className="app-constraint-input"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
    </label>
  )
}

/** 一个模块的栏宽约束编辑行：min/max 两个输入加一个重置按钮。 */
function ConstraintsRow({
  module,
  override,
  onChange,
}: {
  module: WorkspaceModule
  override: ModuleConstraints | undefined
  onChange: (moduleId: string, constraints: ModuleConstraints | null) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const collapsedSize = module.collapsedSize ?? DEFAULT_COLLAPSED
  const declaredMin = module.minSize ?? SHELL_MIN
  const declaredMax = module.maxSize ?? SHELL_MAX
  const min = override?.minSize ?? declaredMin
  const max = override?.maxSize ?? declaredMax

  const commit = (field: 'min' | 'max', raw: string) => {
    setError(null)
    const nextMin = field === 'min' && raw !== '' ? Number(raw) : override?.minSize ?? declaredMin
    const nextMax = field === 'max' && raw !== '' ? Number(raw) : override?.maxSize ?? declaredMax
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) {
      setError('需要数字')
      return
    }
    if (nextMin <= collapsedSize) {
      setError(`下限必须大于折叠宽度 ${collapsedSize}px`)
      return
    }
    if (nextMax < nextMin) {
      setError('上限不能小于下限')
      return
    }
    const constraints: ModuleConstraints = {
      minSize: nextMin !== declaredMin ? nextMin : undefined,
      maxSize: nextMax !== declaredMax ? nextMax : undefined,
    }
    if (constraints.minSize === undefined && constraints.maxSize === undefined) {
      onChange(module.id, null)
    } else {
      onChange(module.id, constraints)
    }
  }

  return (
    <div className="app-constraints">
      <ConstraintField
        label="min"
        value={min}
        placeholder={String(declaredMin)}
        onCommit={(raw) => commit('min', raw)}
      />
      <ConstraintField
        label="max"
        value={max}
        placeholder={String(declaredMax)}
        onCommit={(raw) => commit('max', raw)}
      />
      {override ? (
        <button
          type="button"
          className="app-constraint-reset"
          onClick={() => {
            setError(null)
            onChange(module.id, null)
          }}
        >
          重置
        </button>
      ) : null}
      {error ? <span className="app-constraint-error">{error}</span> : null}
    </div>
  )
}

/** 注册信息从活的 modules 数组派生，不另存一份手工清单，避免漂移。 */
function RegistryView({
  modules,
  overrides,
  onChange,
}: {
  modules: WorkspaceModule[]
  overrides: Overrides
  onChange: (moduleId: string, constraints: ModuleConstraints | null) => void
}) {
  return (
    <div className="app-settings">
      <h2 className="app-settings-title">Registry</h2>
      <p>组合根登记的模块清单，栏序即数组顺序。栏宽约束改动即时生效并落在本地。</p>
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
          <div className="app-registry-row">
            <dt>width</dt>
            <dd>
              <ConstraintsRow
                module={module}
                override={overrides[module.id]}
                onChange={onChange}
              />
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
  for (const module of modules) {
    if (!SOURCES[module.id]) throw new Error(`[shell-web] 模块 ${module.id} 未登记来源`)
  }
}

/** 工厂在模块级只调一次，保持 Panel 等组件引用稳定，覆盖值变化时不重肩 iframe 与模块内部状态。 */
const BASE_MODULES: WorkspaceModule[] = [
  createTodoModule(),
  createFsModule({ apiBaseUrl: '/api/fs-web' }),
  createSshModule({ apiBaseUrl: '/api/ssh-web' }),
  createSandboxModule({ apiBase: '/sbx' }),
  createPiWebModule(),
]

/**
 * 内置页面 profile：切换区域布局与模块集合。
 * 布局按 profile 隔离持久化（ursi.workspace:<profileId>），当前选择存于 ursi.workspace:profile。
 */
const PROFILES: WorkspaceProfile[] = [
  {
    id: 'classic',
    title: '经典',
    regions: [
      {
        id: 'main',
        direction: 'horizontal',
        items: [
          { type: 'module', moduleId: 'todo' },
          { type: 'module', moduleId: 'fs-web' },
          { type: 'module', moduleId: 'ssh' },
          { type: 'module', moduleId: 'sandbox' },
          { type: 'module', moduleId: 'pi-web' },
          { type: 'workspace' },
          { type: 'actions' },
        ],
      },
    ],
  },
  {
    id: 'dev',
    title: '开发',
    regions: [
      {
        id: 'primary',
        defaultSize: 640,
        items: [
          { type: 'module', moduleId: 'todo' },
          { type: 'module', moduleId: 'fs-web' },
        ],
      },
      {
        id: 'terminal',
        defaultSize: 520,
        items: [
          { type: 'module', moduleId: 'ssh' },
          { type: 'module', moduleId: 'sandbox' },
        ],
      },
      {
        id: 'assistant',
        defaultSize: 760,
        items: [
          { type: 'module', moduleId: 'pi-web' },
          { type: 'workspace' },
        ],
      },
    ],
  },
  {
    id: 'chat',
    title: '对话',
    regions: [
      {
        id: 'side',
        defaultSize: 360,
        items: [{ type: 'module', moduleId: 'todo' }],
      },
      {
        id: 'chat',
        defaultSize: 900,
        items: [
          { type: 'module', moduleId: 'pi-web' },
          { type: 'workspace' },
          { type: 'actions' },
        ],
      },
    ],
  },
]

/** 组合根装配：覆盖值是宿主状态，变化时重建模块清单与视图。 */
export function useShellRegistry(): ShellRegistry {
  const [overrides, setOverrides] = useState<Overrides>(loadOverrides)

  useEffect(() => {
    try {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
    } catch (error) {
      console.error(error)
    }
  }, [overrides])

  const setModuleConstraints = useCallback(
    (moduleId: string, constraints: ModuleConstraints | null) => {
      setOverrides((prev) => {
        const next = { ...prev }
        if (constraints) next[moduleId] = constraints
        else delete next[moduleId]
        return next
      })
    },
    [],
  )

  const modules = useMemo(
    () =>
      BASE_MODULES.map((module) => {
        const override = overrides[module.id]
        if (!override) return module
        return {
          ...module,
          minSize: override.minSize ?? module.minSize,
          maxSize: override.maxSize ?? module.maxSize,
        }
      }),
    [overrides],
  )

  // views 只建一次；RegistryView 通过 ref 读最新装配，避免编辑约束时自身重肩丢焦点。
  const latest = useRef({ modules, overrides, onChange: setModuleConstraints })
  latest.current = { modules, overrides, onChange: setModuleConstraints }

  const views = useMemo(
    () => [
      { kind: SETTINGS.kind, summary: () => 'Settings', Component: SettingsView },
      {
        kind: REGISTRY.kind,
        summary: () => 'Registry',
        Component: () => <RegistryView {...latest.current} />,
      },
    ],
    [],
  )

  if (import.meta.env.DEV) assertRegistry(modules, views)

  return { modules, views, profiles: PROFILES }
}
