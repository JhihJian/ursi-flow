import type { ComponentType, ReactNode } from 'react'

/** 全局选中：只保存类型与 ID，实体由模块按 ID 自取。 */
export interface Selection {
  kind: string
  id: string
  label?: string
}

/** 侧边栏组件收到的折叠状态与控制。折叠态由模块自己渲染，外壳只负责高度与交互调用。 */
export interface ModuleSidebarProps {
  collapsed: boolean
  collapse: () => void
  expand: () => void
}

/**
 * 模块对外发布的上下文。
 * 选中信息是全局那份；这里声明本模块占用的 kind、摘要，以及状态栏内容。
 */
export interface ModuleContext {
  /** 本模块对外发布的选中类型，形如 `<域>.<实体>`；不发布选中时省略。 */
  kind?: string
  /** 选中摘要，状态栏与右侧控制面板用它。 */
  summary?: (selection: Selection) => string
  /** 状态栏组件；省略时状态栏只在选中属于本模块时显示 summary。 */
  Status?: ComponentType
}

/** 子模块的完整声明：侧边栏、工作区、上下文。 */
export interface WorkspaceModule {
  id: string
  title: string
  /**
   * 该模块三块内容的共同 React 上下文根（dnd、路由、controller 等）。
   * 必须是纯上下文组件：不渲染 DOM、不参与布局，否则侧边栏与工作区会各拿一份。
   */
  Provider?: ComponentType<{ children: ReactNode }>
  /** 侧边栏内容。折叠态也由它渲染，外壳只把这一节压到 collapsedSidebarSize。 */
  Sidebar: ComponentType<ModuleSidebarProps>
  /** 工作区内容。不得包含模块标题区，标题在侧边栏。 */
  Workspace: ComponentType
  context: ModuleContext
  /** 侧边栏展开高度，缺省 260px。 */
  sidebarDefaultSize?: number
  /** 侧边栏最小高度，缺省 120px。 */
  sidebarMinSize?: number
  /** 侧边栏最大高度（占侧栏总高的上限），缺省 620px。 */
  sidebarMaxSize?: number
  /** 侧边栏折叠后的高度，缺省 32px。 */
  collapsedSidebarSize?: number
  /** 默认展开侧边栏；profile 里没有任何模块声明时默认展开第一个。 */
  defaultExpanded?: boolean
  /** 侧边栏折叠时保留 Workspace 挂载（iframe、终端等需要保持运行状态的模块）。 */
  keepMounted?: boolean
  actions?: WorkspaceAction[]
}

/** 上下文操作：由模块声明，外壳只在右侧控制面板按选中渲染。 */
export interface WorkspaceAction {
  id: string
  label: string
  appliesTo: (selection: Selection | null) => boolean
  run: (selection: Selection) => Promise<void>
  disabledReason?: (selection: Selection) => string | null
  confirm?: string
}

/** 不占侧边栏的宿主页面，例如全局设置；选中这类 kind 时占用整个工作区。 */
export interface WorkspaceView {
  kind: string
  summary: (selection: Selection) => string
  Component: ComponentType<{ selection: Selection }>
}

/** 页面 profile：声明启用哪些模块，顺序即侧边栏堆叠顺序与工作区列顺序。 */
export interface WorkspaceProfile {
  id: string
  title: string
  modules: string[]
}

export interface WorkspaceShellProps {
  modules: WorkspaceModule[]
  /** 页面 profile：切换启用模块与顺序，≥2 个时标题栏出现切换器。缺省启用全部模块。 */
  profiles?: WorkspaceProfile[]
  /** 标题栏文字。 */
  title?: string
  /** 标题栏右侧内容；省略且提供 onSettings 时用默认设置按钮。 */
  settings?: ReactNode
  onSettings?: () => void
  /** 状态栏右侧内容。 */
  status?: ReactNode
  /** 宿主页面（设置、注册表等）。 */
  views?: WorkspaceView[]
  /** 侧边栏高度、工作区宽度与展开状态的存储前缀。 */
  storageKey?: string
  /** 操作失败时的提示，缺省 console.error。 */
  onError?: (error: unknown) => void
}
