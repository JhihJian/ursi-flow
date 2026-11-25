import { useState } from 'react'
import { Panel, Separator, usePanelRef } from 'react-resizable-panels'
import type { WorkspaceModule } from './contracts'
import { ModuleColumnProvider } from './context'
import './shell.css'

export const DEFAULT_COLLAPSED_SIZE = 32
export const DEFAULT_MAX_SIZE = 760

/** 栏的尺寸与折叠控制：模块栏、区域里的工作区/操作栏条目共用。 */
export interface StackSizing {
  width: number
  collapsed: boolean
  resize: (width: number) => void
  collapse: () => void
  expand: () => void
}

/**
 * Panel 折叠状态与宽度跟踪。区域条目共用一个控制器：
 * onResize 里把「小于等于折叠尺寸」判定为折叠态，展开时回到折叠前宽度。
 */
export function useStackPanel(options: { defaultSize: number; collapsedSize: number }) {
  const panelRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(options.defaultSize)
  const [lastWidth, setLastWidth] = useState(options.defaultSize)

  const onResize = (size: { inPixels: number }) => {
    const next = size.inPixels <= options.collapsedSize + 1
    if (!next) {
      setLastWidth(size.inPixels)
      setWidth(size.inPixels)
    }
    setCollapsed(next)
  }
  const collapse = () => panelRef.current?.collapse()
  const expand = () => panelRef.current?.resize(lastWidth)
  const resize = (next: number) => {
    panelRef.current?.resize(next)
  }

  return { panelRef, collapsed, width, collapse, expand, resize, onResize }
}

/** 折叠态窄条：外壳按模块公布的关键信息排版，模块不参与渲染。vertical 时为横向书脊。 */
function ModuleRail({
  module,
  vertical,
  onExpand,
}: {
  module: WorkspaceModule
  vertical: boolean
  onExpand: () => void
}) {
  const useSummary = module.useCollapsedSummary
  const summary = useSummary
    ? useSummary()
    : { title: module.title, items: [] }
  const text = [summary.title, ...summary.items.map((item) => `${item.label}: ${item.value}`)].join(' · ')

  return (
    <div className={vertical ? 'ws-rail ws-rail-h' : 'ws-rail'}>
      <button
        type="button"
        className="ws-rail-toggle"
        title={`展开 ${module.title}`}
        aria-label={`展开 ${module.title}`}
        onClick={onExpand}
      >
        {vertical ? '˅' : '»'}
      </button>
      <button
        type="button"
        className="ws-rail-summary"
        onClick={onExpand}
        title={text}
        aria-label={`${text}。展开 ${module.title}`}
      >
        <span className="ws-rail-title">{summary.title}</span>
        {summary.items.map((item) => (
          <span key={item.label} className="ws-rail-item">
            <span className="ws-rail-label">{item.label}</span>
            <span className="ws-rail-value">{item.value}</span>
          </span>
        ))}
      </button>
    </div>
  )
}

/**
 * 模块栏内容：折叠态渲染外壳排版的窄条，展开态渲染标题行（stack 内常显）与模块内容。
 * 模块声明 hideHeader 时 flat 布局不渲染标题行，折叠入口移到分隔线上。
 */
export function ModulePanelContent({
  module,
  vertical = false,
  inStack = false,
  sizing,
}: {
  module: WorkspaceModule
  /** 所在区域的排列方向，决定书脊朝向与折叠按钮字形。 */
  vertical?: boolean
  /** 位于区域纵向堆叠内时标题行常显，保证折叠入口可用。 */
  inStack?: boolean
  sizing: StackSizing
}) {
  const Body = module.Panel

  return (
    <ModuleColumnProvider value={sizing}>
      {sizing.collapsed && !module.keepMounted ? (
        <ModuleRail module={module} vertical={vertical} onExpand={sizing.expand} />
      ) : (
        <div className={sizing.collapsed ? 'ws-panel-body ws-panel-body-hidden' : 'ws-panel-body'}>
          {(!module.hideHeader || inStack) && (
            <header className="ws-panel-head">
              <span className="ws-panel-title">{module.title}</span>
              <button
                type="button"
                className="ws-rail-toggle"
                title={`折叠 ${module.title}`}
                aria-label={`折叠 ${module.title}`}
                onClick={sizing.collapse}
              >
                {vertical ? '˄' : '«'}
              </button>
            </header>
          )}
          <div className="ws-panel-content">
            <Body />
          </div>
        </div>
      )}
      {sizing.collapsed && module.keepMounted ? (
        <ModuleRail module={module} vertical={vertical} onExpand={sizing.expand} />
      ) : null}
    </ModuleColumnProvider>
  )
}

/** flat 布局里的一个模块栏：自带尾部分隔线，hideHeader 时分隔线顶放置折叠按钮。 */
export function ModuleColumn({ module }: { module: WorkspaceModule }) {
  const collapsedSize = module.collapsedSize ?? DEFAULT_COLLAPSED_SIZE
  const sizing = useStackPanel({ defaultSize: module.defaultSize ?? 360, collapsedSize })

  return (
    <>
      <Panel
        id={module.id}
        className={sizing.collapsed ? 'ws-panel ws-panel-collapsed' : 'ws-panel'}
        panelRef={sizing.panelRef}
        defaultSize={module.defaultSize ?? 360}
        minSize={module.minSize ?? 240}
        maxSize={module.maxSize ?? DEFAULT_MAX_SIZE}
        collapsible
        collapsedSize={collapsedSize}
        groupResizeBehavior="preserve-pixel-size"
        onResize={sizing.onResize}
      >
        <ModulePanelContent module={module} sizing={sizing} />
      </Panel>
      <Separator className="ws-separator" title={`拖动调整 ${module.title} 宽度`}>
        {module.hideHeader && !sizing.collapsed ? (
          <button
            type="button"
            className="ws-separator-pin"
            title={`折叠 ${module.title}`}
            aria-label={`折叠 ${module.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={sizing.collapse}
          >
            ‹
          </button>
        ) : null}
      </Separator>
    </>
  )
}

/** 区域 Group 里的模块条目：自带 Panel 与折叠机制，标题行常显保证折叠入口可用。 */
export function ModuleRegionItem({
  module,
  panelId,
  vertical = false,
}: {
  module: WorkspaceModule
  panelId: string
  vertical?: boolean
}) {
  const collapsedSize = module.collapsedSize ?? DEFAULT_COLLAPSED_SIZE
  const sizing = useStackPanel({ defaultSize: module.defaultSize ?? 360, collapsedSize })

  return (
    <Panel
      id={panelId}
      className={sizing.collapsed ? 'ws-panel ws-panel-collapsed' : 'ws-panel'}
      panelRef={sizing.panelRef}
      minSize={module.minSize ?? 240}
      maxSize={module.maxSize ?? DEFAULT_MAX_SIZE}
      collapsible
      collapsedSize={collapsedSize}
      groupResizeBehavior="preserve-pixel-size"
      onResize={sizing.onResize}
    >
      <ModulePanelContent module={module} vertical={vertical} inStack sizing={sizing} />
    </Panel>
  )
}
