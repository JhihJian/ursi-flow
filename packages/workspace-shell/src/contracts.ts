import type { ComponentType } from 'react'

/** 全局选中：只保存类型与 ID，实体由模块按 ID 自取。 */
export interface Selection {
  kind: string
  id: string
  label?: string
}

export interface RailProps {
  onExpand: () => void
  title: string
}

/** 一栏模块。外壳只负责布局、折叠与选中，内容与数据归模块自己。 */
export interface WorkspaceModule {
  id: string
  title: string
  /** 展开态内容，自带数据获取。 */
  Panel: ComponentType
  /** 折叠态窄条，缺省用竖排标题。 */
  Rail?: ComponentType<RailProps>
  defaultSize?: number
  minSize?: number
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

export interface WorkspaceShellProps {
  modules: WorkspaceModule[]
  /** 布局与折叠状态的存储键。 */
  storageKey?: string
  /** 操作失败时的提示，缺省 console.error。 */
  onError?: (error: unknown) => void
}
