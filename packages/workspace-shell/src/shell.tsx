import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type {
  ModuleSidebarProps,
  Selection,
  ShellHandle,
  WorkspaceModule,
  WorkspaceProfile,
  WorkspaceShellProps,
  WorkspaceView,
} from './contracts'
import { useWorkspace, WorkspaceProvider } from './context'
import {
  ModuleHost,
  Slot,
  SlotProvider,
  hiddenSlotName,
  sidebarSlotName,
  statusSlotName,
  workspaceSlotName,
} from './slots'
import './shell.css'

const DEFAULT_COLLAPSED_SIZE = 32

/** localStorage 写入按 key 合并延迟，拖动分隔线时不会每帧写盘。 */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function saveNumber(key: string, value: number): void {
  const timer = pendingWrites.get(key)
  if (timer) clearTimeout(timer)
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key)
      try {
        window.localStorage.setItem(key, String(Math.round(value)))
      } catch (error) {
        console.error(error)
      }
    }, 150),
  )
}

/** 侧边栏只有一节展开，存单个模块 id；没有展开项时不写盘。 */
function readExpandedId(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw && raw.trim() ? raw.trim() : null
  } catch {
    return null
  }
}

function saveExpandedId(key: string, moduleId: string | null): void {
  try {
    if (moduleId) window.localStorage.setItem(key, moduleId)
    else window.localStorage.removeItem(key)
  } catch (error) {
    console.error(error)
  }
}

/** 面板尺寸：读取已保存的像素值，写入时延迟合并。 */
function useStoredSize(key: string, fallback: number): [number, (pixels: number) => void] {
  const [size] = useState(() => readNumber(key) ?? fallback)
  const save = useCallback(
    (pixels: number) => {
      if (pixels > 0) saveNumber(key, pixels)
    },
    [key],
  )
  return [size, save]
}

/** 侧边栏堆叠：同一时刻只有一节展开，其余模块压成一条横向窄条。 */
function SidebarStack({
  modules,
  expandedId,
  onToggle,
  workspaceVisibleIds,
}: {
  modules: WorkspaceModule[]
  expandedId: string | null
  onToggle: (moduleId: string, expanded: boolean) => void
  workspaceVisibleIds: Set<string>
}) {
  return (
    <div className="ws-sidebar-stack">
      {modules.map((module) => {
        const expanded = module.id === expandedId
        const sidebarProps: ModuleSidebarProps = {
          collapsed: !expanded,
          collapse: () => onToggle(module.id, false),
          expand: () => onToggle(module.id, true),
        }
        return (
          <section
            key={module.id}
            className={expanded ? 'ws-sidebar-section' : 'ws-sidebar-section ws-sidebar-section-collapsed'}
            style={
              expanded
                ? { flex: '1 1 0', minHeight: 0 }
                : { flex: `0 0 ${module.collapsedSidebarSize ?? DEFAULT_COLLAPSED_SIZE}px` }
            }
          >
            <Slot name={sidebarSlotName(module.id)} className="ws-slot" />
            <ModuleHost
              module={module}
              sidebarProps={sidebarProps}
              workspaceVisible={workspaceVisibleIds.has(module.id)}
              statusVisible={expanded}
            />
          </section>
        )
      })}
    </div>
  )
}

/** 右侧集成控制面板：只列当前选中可用的操作，操作来自已启用模块。 */
function ControlPanel({
  modules,
  shell,
  onError,
}: {
  modules: WorkspaceModule[]
  shell: ShellHandle
  onError: (error: unknown) => void
}) {
  const { selection } = useWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const items = modules.flatMap((module) =>
    (module.actions ?? []).map((action) => ({ module, action })),
  )
  const applicable = selection
    ? items.filter(({ action }) => action.appliesTo(selection, shell))
    : []
  const summary = selection ? summaryFor(modules, selection) : '未选中'

  const run = async (actionId: string, execute: () => Promise<void>) => {
    setError(null)
    setBusy(actionId)
    try {
      await execute()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      onError(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ws-control">
      <div className="ws-control-head">
        <span className="ws-control-title">控制</span>
      </div>
      <p className="ws-control-selection">{summary}</p>
      <div className="ws-control-list">
        {applicable.length === 0 ? (
          <span className="ws-control-empty">当前选中没有可用操作。</span>
        ) : (
          applicable.map(({ module, action }) => {
            const reason = selection ? (action.disabledReason?.(selection, shell) ?? null) : null
            return (
              <button
                key={`${module.id}:${action.id}`}
                type="button"
                className="ws-action"
                disabled={Boolean(reason) || busy !== null}
                title={reason ?? undefined}
                onClick={() => {
                  if (!selection) return
                  const confirmText =
                    typeof action.confirm === 'function'
                      ? action.confirm(selection, shell)
                      : action.confirm
                  if (confirmText && !window.confirm(confirmText)) return
                  void run(action.id, () => action.run(selection, shell))
                }}
              >
                {busy === action.id ? '进行中…' : action.label}
              </button>
            )
          })
        )}
        {error ? <span className="ws-control-error">{error}</span> : null}
      </div>
    </div>
  )
}

function summaryFor(modules: WorkspaceModule[], selection: Selection): string {
  for (const module of modules) {
    if (module.context.kind === selection.kind && module.context.summary) {
      return module.context.summary(selection)
    }
  }
  return selection.label ?? selection.id
}

function findView(views: WorkspaceView[], selection: Selection | null): WorkspaceView | null {
  if (!selection) return null
  return views.find((view) => view.kind === selection.kind) ?? null
}

/** 工作区：宿主页面优先；否则渲染展开模块的那一列，没有展开模块时显示占位。 */
function WorkspaceArea({
  module,
  views,
}: {
  module: WorkspaceModule | null
  views: WorkspaceView[]
}) {
  const { selection } = useWorkspace()
  const view = findView(views, selection)
  if (view) {
    const View = view.Component
    return (
      <div className="ws-workspace-view">
        <View selection={selection!} />
      </div>
    )
  }
  if (!module) {
    return (
      <div className="ws-placeholder">
        <span className="ws-placeholder-title">Work space</span>
        <span className="ws-placeholder-text">展开左侧任一模块的侧边栏以显示它的工作区。</span>
      </div>
    )
  }
  return (
    <div className="ws-workspace-column">
      <Slot name={workspaceSlotName(module.id)} className="ws-slot" />
    </div>
  )
}

/** 状态栏里的模块上下文：有 Status 组件就留槽位，否则显示本模块的选中摘要。 */
function StatusSegments({
  modules,
  selection,
}: {
  modules: WorkspaceModule[]
  selection: Selection | null
}) {
  const segments = modules.flatMap((module) => {
    if (module.context.Status) {
      return [{ module, node: <Slot key={module.id} name={statusSlotName(module.id)} /> }]
    }
    if (
      selection &&
      module.context.kind === selection.kind &&
      module.context.summary
    ) {
      return [{ module, node: <span key={module.id}>{module.context.summary(selection)}</span> }]
    }
    return []
  })

  if (segments.length === 0) {
    return <span className="ws-status-selection">{selection ? selection.id : 'No selection'}</span>
  }
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={segment.module.id}>
          {index > 0 ? <span className="ws-status-sep">·</span> : null}
          <span className="ws-status-item">{segment.node}</span>
        </Fragment>
      ))}
    </>
  )
}

interface SurfaceProps {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  profile: WorkspaceProfile
  storageKey: string
  status?: ReactNode
  onError: (error: unknown) => void
}

/** 一个 profile 的固定骨架：侧边栏堆叠 + 工作区 + 控制面板。profile 切换时整体重挂。 */
function Surface({ modules, views, profile, storageKey, status, onError }: SurfaceProps) {
  const enabled = useMemo(
    () =>
      profile.modules
        .map((id) => modules.find((module) => module.id === id))
        .filter((module): module is WorkspaceModule => Boolean(module)),
    [modules, profile.modules],
  )
  const enabledKey = enabled.map((module) => module.id).join(',')

  const expandedKey = `${storageKey}:expanded`
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    const stored = readExpandedId(expandedKey)
    if (stored && profile.modules.includes(stored)) return stored
    const declared = enabled.find((module) => module.defaultExpanded)
    return declared ? declared.id : (enabled[0]?.id ?? null)
  })

  useEffect(() => {
    saveExpandedId(expandedKey, expandedId)
  }, [expandedKey, expandedId])

  // profile 或模块集合变化后，丢掉不再启用的展开项。
  useEffect(() => {
    setExpandedId((previous) =>
      previous && enabled.some((module) => module.id === previous) ? previous : null,
    )
  }, [enabledKey, enabled])

  const onExpandedChange = useCallback((moduleId: string, expanded: boolean) => {
    setExpandedId((previous) => (expanded ? moduleId : previous === moduleId ? null : previous))
  }, [])

  const { selection, select } = useWorkspace()
  const view = findView(views, selection)
  const expandedModule = view ? null : (enabled.find((module) => module.id === expandedId) ?? null)
  const visibleIds = new Set(expandedModule ? [expandedModule.id] : [])

  /** 交给模块操作的外壳能力：启用集合按当前 profile 计算，reveal 只做展开与视图回退。 */
  const shell = useMemo<ShellHandle>(() => {
    const enabledIds = new Set(enabled.map((module) => module.id))
    const viewKinds = new Set(views.map((view) => view.kind))
    return {
      enabled: (moduleId) => enabledIds.has(moduleId),
      reveal: (moduleId) => {
        if (!enabledIds.has(moduleId)) {
          throw new Error(`模块 ${moduleId} 未在当前 profile 中启用`)
        }
        setExpandedId(moduleId)
        // 宿主页面占着工作区时先退回模块视图，否则展开后仍然看不见目标模块。
        if (selection && viewKinds.has(selection.kind)) select(null)
      },
    }
  }, [enabled, views, selection, select])

  const [sidebarSize, saveSidebarSize] = useStoredSize(`${storageKey}:body:sidebar`, 300)
  const [controlSize, saveControlSize] = useStoredSize(`${storageKey}:body:control`, 260)

  return (
    <>
      <div className="ws-body">
        <Group orientation="horizontal" className="ws-body-group">
          <Panel
            id="sidebar"
            className="ws-sidebar"
            defaultSize={sidebarSize}
            minSize={200}
            maxSize={560}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => saveSidebarSize(size.inPixels)}
          >
            <SidebarStack
              modules={enabled}
              expandedId={expandedId}
              onToggle={onExpandedChange}
              workspaceVisibleIds={visibleIds}
            />
          </Panel>
          <Separator className="ws-separator" />
          <Panel id="workspace" className="ws-workspace" minSize={320}>
            <WorkspaceArea module={expandedModule} views={views} />
          </Panel>
          <Separator className="ws-separator" />
          <Panel
            id="control"
            className="ws-control-panel"
            defaultSize={controlSize}
            minSize={200}
            maxSize={420}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => saveControlSize(size.inPixels)}
          >
            <ControlPanel modules={enabled} shell={shell} onError={onError} />
          </Panel>
        </Group>
        <div className="ws-hidden-hosts" aria-hidden="true">
          {enabled.map((module) => (
            <Slot key={module.id} name={hiddenSlotName(module.id)} />
          ))}
        </div>
      </div>
      <footer className="ws-statusbar">
        <div className="ws-status-left">
          <StatusSegments modules={expandedModule ? [expandedModule] : []} selection={selection} />
        </div>
        <span className="ws-status-extra">{status}</span>
      </footer>
    </>
  )
}

function Shell({
  modules,
  views = [],
  profiles,
  title = 'Workspace',
  settings,
  onSettings,
  status,
  onError,
  storageKey,
}: Required<Pick<WorkspaceShellProps, 'storageKey'>> & WorkspaceShellProps) {
  const reportError = useMemo(
    () => onError ?? ((error: unknown) => console.error(error)),
    [onError],
  )
  const allIds = modules.map((module) => module.id)
  const activeProfiles: WorkspaceProfile[] = profiles?.length
    ? profiles
    : [{ id: 'all', title: '全部', modules: allIds }]

  const [profileId, setProfileId] = useState<string | null>(() => {
    const saved = window.localStorage.getItem(`${storageKey}:profile`)
    return saved && activeProfiles.some((profile) => profile.id === saved) ? saved : null
  })
  const activeId = profileId ?? activeProfiles[0]?.id ?? 'all'
  const activeProfile = activeProfiles.find((profile) => profile.id === activeId) ?? activeProfiles[0]!

  useEffect(() => {
    if (profileId) window.localStorage.setItem(`${storageKey}:profile`, profileId)
  }, [storageKey, profileId])

  return (
    <div className="ws-shell">
      <header className="ws-titlebar">
        <span className="ws-title">{title}</span>
        <div className="ws-titlebar-right">
          {activeProfiles.length >= 2 ? (
            <select
              className="ws-profile-select"
              value={activeId}
              aria-label="页面 profile"
              onChange={(event) => setProfileId(event.target.value)}
            >
              {activeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.title}
                </option>
              ))}
            </select>
          ) : null}
          {settings ??
            (onSettings ? (
              <button type="button" className="ws-settings" onClick={onSettings}>
                设置
              </button>
            ) : null)}
        </div>
      </header>
      <SlotProvider>
        <Surface
          key={`${activeProfile.id}:${storageKey}`}
          modules={modules}
          views={views}
          profile={activeProfile}
          storageKey={`${storageKey}:${activeProfile.id}`}
          status={status}
          onError={reportError}
        />
      </SlotProvider>
    </div>
  )
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const { storageKey = 'ursi.workspace-shell' } = props
  return (
    <WorkspaceProvider>
      <Shell {...props} storageKey={storageKey} />
    </WorkspaceProvider>
  )
}
