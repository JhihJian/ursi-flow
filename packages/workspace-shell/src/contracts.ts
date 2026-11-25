import type { ComponentType, ReactNode } from 'react'

/** 全局选中：只保存类型与 ID，实体由模块按 ID 自取。 */
export interface Selection {
  kind: string
  id: string
  label?: string
}

/** 折叠态由模块公布的关键信息，外壳负责排版，模块不写折叠 UI。 */
export interface CollapsedSummary {
  title: string
  items: Array<{ label: string; value: string }>
}

/** 一栏模块。外壳只负责布局、折叠与选中，内容与数据归模块自己。 */
export interface WorkspaceModule {
  id: string
  title: string
  /** 展开态内容，自带数据获取。 */
  Panel: ComponentType
  /** 折叠态要展示的关键信息；缺省只显示模块标题。 */
  useCollapsedSummary?: () => CollapsedSummary
  defaultSize?: number
  /** 栏宽下限，缺省 240px。 */
  minSize?: number
  /** 栏宽上限，缺省 760px；iframe、编辑器这类需要宽内容的模块可调大。 */
  maxSize?: number
  /** 折叠后的宽度，缺省 32px；模块用自己的内部最小宽度时按需覆盖。 */
  collapsedSize?: number
  /** 模块自身已有标题或工具条时隐藏外壳的标题行，折叠按钮改为右上角悬浮。 */
  hideHeader?: boolean
  /** 折叠时保留 Panel 挂载，仅用 CSS 隐藏；适合 iframe 等需要保持运行状态的模块。缺省 false（折叠即卸载）。 */
  keepMounted?: boolean
  /** 该模块对外暴露的选中类型，供工作区区域匹配视图。 */
  selection?: {
    kind: string
    summary: (selection: Selection) => string
    WorkspaceView?: ComponentType<{ selection: Selection }>
  }
  actions?: WorkspaceAction[]
}

/** 上下文操作：由模块声明，外壳只按选中渲染按钮。 */
export interface WorkspaceAction {
  id: string
  label: string
  appliesTo: (selection: Selection | null) => boolean
  run: (selection: Selection) => Promise<void>
  disabledReason?: (selection: Selection) => string | null
  confirm?: string
}

/** 不占栏的视图，例如全局设置页；按选中类型匹配。 */
export interface WorkspaceView {
  kind: string
  summary: (selection: Selection) => string
  Component: ComponentType<{ selection: Selection }>
}

/** 区域条目：模块栏、工作区区域或操作栏。 */
export type WorkspaceRegionItem =
  | { type: 'module'; moduleId: string }
  | { type: 'workspace' }
  | { type: 'actions' }

/** 区域：一组条目按同一方向叠放。 */
export interface WorkspaceRegionSpec {
  id: string
  /** 条目排列方向，缺省 'vertical' 自上而下；此时模块的尺寸契约字段（defaultSize/minSize/maxSize/collapsedSize）作用于高度。 */
  direction?: 'horizontal' | 'vertical'
  /** 区域默认宽度（px），只在多区域 profile 的根布局生效，缺省 720。 */
  defaultSize?: number
  items: WorkspaceRegionItem[]
}

/** 页面 profile：一份区域布局与模块集合声明，由组合根提供。 */
export interface WorkspaceProfile {
  id: string
  title: string
  regions: WorkspaceRegionSpec[]
}

export interface WorkspaceShellProps {
  modules: WorkspaceModule[]
  /** 页面 profile：切换区域布局与模块集合，≥2 个时标题栏出现切换器。缺省单横向平铺全部模块（与历史行为一致）。 */
  profiles?: WorkspaceProfile[]
  /** 标题栏文字。 */
  title?: string
  /** 标题栏右侧内容，通常放设置按钮；省略且提供 onSettings 时用默认按钮。 */
  settings?: ReactNode
  onSettings?: () => void
  /** 状态栏右侧内容。 */
  status?: ReactNode
  /** 不占栏的视图，例如全局设置。 */
  views?: WorkspaceView[]
  /** 布局与折叠状态的存储键；当前 profile 存在 `${storageKey}:profile`。 */
  storageKey?: string
  /** 操作失败时的提示，缺省 console.error。 */
  onError?: (error: unknown) => void
}
