import { useState, type ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import type {
  RailProps,
  Selection,
  WorkspaceAction,
  WorkspaceModule,
  WorkspaceShellProps,
  WorkspaceView,
} from './contracts'
import { ModuleColumnProvider, useWorkspace, WorkspaceProvider } from './context'
import './shell.css'

const DEFAULT_COLLAPSED_SIZE = 32
const ACTIONS_SIZE = 260

function DefaultRail({ onExpand, title }: RailProps) {
  return (
    <div className="ws-rail">
      <button
        type="button"
        className="ws-rail-toggle"
        title={`展开 ${title}`}
        aria-label={`展开 ${title}`}
        onClick={onExpand}
      >
        »
      </button>
      <button type="button" className="ws-rail-summary" onClick={onExpand} title={title}>
        <span className="ws-rail-name">{title}</span>
      </button>
    </div>
  )
}

function ModuleColumn({ module }: { module: WorkspaceModule }) {
  const panelRef = usePanelRef()
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(module.defaultSize ?? 360)
  const [lastWidth, setLastWidth] = useState(module.defaultSize ?? 360)
  const Rail = module.Rail ?? DefaultRail
  const Body = module.Panel
  const collapsedSize = module.collapsedSize ?? DEFAULT_COLLAPSED_SIZE

  const collapse = () => panelRef.current?.collapse()
  const expand = () => panelRef.current?.resize(lastWidth)
  const resize = (next: number) => {
    panelRef.current?.resize(next)
  }

  return (
    <>
      <Panel
      id={module.id}
      className={collapsed ? 'ws-panel ws-panel-collapsed' : 'ws-panel'}
      panelRef={panelRef}
      defaultSize={module.defaultSize ?? 360}
      minSize={module.minSize ?? 240}
      maxSize={760}
      collapsible
      collapsedSize={collapsedSize}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(size) => {
        const next = size.inPixels <= collapsedSize + 1
        if (!next) {
          setLastWidth(size.inPixels)
          setWidth(size.inPixels)
        }
        setCollapsed(next)
      }}
    >
      <ModuleColumnProvider value={{ width, collapsed, resize, collapse, expand }}>
        {collapsed ? (
          <Rail onExpand={expand} title={module.title} />
        ) : module.hideHeader ? (
          <div className="ws-panel-body">
            <div className="ws-panel-content">
              <Body />
            </div>
          </div>
        ) : (
          <div className="ws-panel-body">
            <header className="ws-panel-head">
              <span className="ws-panel-title">{module.title}</span>
              <button
                type="button"
                className="ws-rail-toggle"
                title={`折叠 ${module.title}`}
                aria-label={`折叠 ${module.title}`}
                onClick={collapse}
              >
                «
              </button>
            </header>
            <div className="ws-panel-content">
              <Body />
            </div>
          </div>
        )}
      </ModuleColumnProvider>
    </Panel>
      <Separator className="ws-separator" title={`拖动调整 ${module.title} 宽度`}>
        {module.hideHeader && !collapsed ? (
          <button
            type="button"
            className="ws-separator-pin"
            title={`折叠 ${module.title}`}
            aria-label={`折叠 ${module.title}`}
            onClick={collapse}
          >
            ‹
          </button>
        ) : null}
      </Separator>
    </>
  )
}

function findWorkspaceView(
  modules: WorkspaceModule[],
  views: WorkspaceView[],
  selection: Selection | null,
): ReactNode {
  if (!selection) return null
  for (const view of views) {
    if (view.kind !== selection.kind) continue
    const View = view.Component
    return <View selection={selection} />
  }
  for (const module of modules) {
    const kind = module.selection
    if (!kind || kind.kind !== selection.kind || !kind.WorkspaceView) continue
    const View = kind.WorkspaceView
    return <View selection={selection} />
  }
  return null
}

function WorkspaceRegion({ modules, views }: { modules: WorkspaceModule[]; views: WorkspaceView[] }) {
  const { selection } = useWorkspace()
  const view = findWorkspaceView(modules, views, selection)

  return (
    <Panel id="workspace" className="ws-workspace" minSize={280}>
      {view ?? (
        <div className="ws-placeholder">
          <span className="ws-placeholder-title">Workspace</span>
          <span className="ws-placeholder-text">
            {selection
              ? `No workspace view is registered for ${selection.kind}.`
              : 'Select something in a panel to see its details here.'}
          </span>
        </div>
      )}
    </Panel>
  )
}

function ActionsPanel({ modules }: { modules: WorkspaceModule[] }) {
  const { selection } = useWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const items = modules.flatMap((module) =>
    (module.actions ?? []).map((action) => ({ module, action })),
  )
  const applicable = selection
    ? items.filter(({ action }) => action.appliesTo(selection))
    : []
  const summary = selection ? (summaryFor(modules, selection) ?? selection.id) : 'Nothing selected'

  const run = async (action: WorkspaceAction) => {
    if (!selection) return
    if (action.confirm && !window.confirm(action.confirm)) return
    setError(null)
    setBusy(action.id)
    try {
      await action.run(selection)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      id="actions"
      className="ws-actions"
      defaultSize={ACTIONS_SIZE}
      minSize={200}
      maxSize={380}
    >
      <div className="ws-actions-head">
        <span className="ws-actions-title">Actions</span>
      </div>
      <p className="ws-actions-selection">{summary}</p>
      <div className="ws-actions-list">
        {applicable.length === 0 ? (
          <span className="ws-actions-empty">No actions for the current selection.</span>
        ) : (
          applicable.map(({ module, action }) => {
            const reason = selection ? (action.disabledReason?.(selection) ?? null) : null
            return (
              <button
                key={`${module.id}:${action.id}`}
                type="button"
                className="ws-action"
                disabled={Boolean(reason) || busy !== null}
                title={reason ?? undefined}
                onClick={() => void run(action)}
              >
                {busy === action.id ? 'Working…' : action.label}
              </button>
            )
          })
        )}
        {error ? <span className="ws-actions-error">{error}</span> : null}
      </div>
    </Panel>
  )
}

function summaryFor(modules: WorkspaceModule[], selection: Selection): string | null {
  const module = modules.find((candidate) => candidate.selection?.kind === selection.kind)
  return module?.selection?.summary(selection) ?? null
}

function Shell({
  modules,
  views = [],
  title = 'Workspace',
  settings,
  onSettings,
  status,
  storageKey = 'ursi.workspace-shell',
}: WorkspaceShellProps) {
  const layout = useDefaultLayout({ id: storageKey })
  const { selection } = useWorkspace()
  const summary = selection
    ? (summaryFor(modules, selection) ?? views.find((view) => view.kind === selection.kind)?.summary(selection) ?? selection.id)
    : 'No selection'

  return (
    <div className="ws-shell">
      <header className="ws-titlebar">
        <span className="ws-title">{title}</span>
        <div className="ws-titlebar-right">
          {settings ?? (onSettings ? (
            <button type="button" className="ws-settings" onClick={onSettings}>
              Settings
            </button>
          ) : null)}
        </div>
      </header>
      <div className="ws-body">
        <Group
          orientation="horizontal"
          className="ws-root"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          {modules.map((module) => (
            <ModuleColumn key={module.id} module={module} />
          ))}
          <WorkspaceRegion modules={modules} views={views} />
          <Separator className="ws-separator" />
          <ActionsPanel modules={modules} />
        </Group>
      </div>
      <footer className="ws-statusbar">
        <span className="ws-status-selection">{summary}</span>
        <span className="ws-status-extra">{status}</span>
      </footer>
    </div>
  )
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  return (
    <WorkspaceProvider>
      <Shell {...props} />
    </WorkspaceProvider>
  )
}
