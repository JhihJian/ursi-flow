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
  minSize?: number
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

export interface WorkspaceShellProps {
  modules: WorkspaceModule[]
  /** 标题栏文字。 */
  title?: string
  /** 标题栏右侧内容，通常放设置按钮；省略且提供 onSettings 时用默认按钮。 */
  settings?: ReactNode
  onSettings?: () => void
  /** 状态栏右侧内容。 */
  status?: ReactNode
  /** 不占栏的视图，例如全局设置。 */
  views?: WorkspaceView[]
  /** 布局与折叠状态的存储键。 */
  storageKey?: string
  /** 操作失败时的提示，缺省 console.error。 */
  onError?: (error: unknown) => void
}
