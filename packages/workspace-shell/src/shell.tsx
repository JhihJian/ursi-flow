import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type {
  ModuleSidebarProps,
  Selection,
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

const DEFAULT_SIDEBAR_SIZE = 260
const DEFAULT_SIDEBAR_MIN = 120
const DEFAULT_SIDEBAR_MAX = 620
const DEFAULT_COLLAPSED_SIZE = 32
const DEFAULT_WORKSPACE_SIZE = 480
const DEFAULT_WORKSPACE_MIN = 280

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

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** 侧边栏高度权重延迟写盘，拖动时不必每帧写 localStorage。 */
const pendingJsonWrites = new Map<string, ReturnType<typeof setTimeout>>()

function saveJsonDebounced(key: string, value: unknown): void {
  const timer = pendingJsonWrites.get(key)
  if (timer) clearTimeout(timer)
  pendingJsonWrites.set(
    key,
    setTimeout(() => {
      pendingJsonWrites.delete(key)
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        console.error(error)
      }
    }, 150),
  )
}

function readStringList(key: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null
  } catch {
    return null
  }
}

function saveStringList(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
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

/** 侧边栏堆叠：展开的模块按权重分高度，折叠的模块固定一条窄条。 */
function SidebarStack({
  modules,
  expandedIds,
  onToggle,
  storageKey,
  workspaceVisibleIds,
}: {
  modules: WorkspaceModule[]
  expandedIds: string[]
  onToggle: (moduleId: string, expanded: boolean) => void
  storageKey: string
  workspaceVisibleIds: Set<string>
}) {
  const sizesKey = `${storageKey}:sidebar-sizes`
  const defaults = useMemo(() => {
    const result: Record<string, number> = {}
    for (const module of modules) result[module.id] = module.sidebarDefaultSize ?? DEFAULT_SIDEBAR_SIZE
    return result
  }, [modules])
  const [sizes, setSizes] = useState<Record<string, number>>(() => ({
    ...defaults,
    ...(readJson<Record<string, number>>(sizesKey) ?? {}),
  }))
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  useEffect(() => {
    saveJsonDebounced(sizesKey, sizes)
  }, [sizesKey, sizes])

  const expandedModules = modules.filter((module) => expandedIds.includes(module.id))

  const startDrag = (belowId: string) => (event: React.PointerEvent) => {
    event.preventDefault()
    const belowModule = modules.find((module) => module.id === belowId)
    const belowElement = sectionRefs.current[belowId]
    if (!belowModule || !belowElement) return
    const index = expandedModules.findIndex((module) => module.id === belowId)
    const aboveModule = index > 0 ? expandedModules[index - 1] : undefined
    const aboveElement = aboveModule ? sectionRefs.current[aboveModule.id] : null
    const belowHeight = belowElement.getBoundingClientRect().height
    const aboveHeight = aboveElement?.getBoundingClientRect().height ?? 0
    const startY = event.clientY
    const minOf = (module: WorkspaceModule) => module.sidebarMinSize ?? DEFAULT_SIDEBAR_MIN
    const maxOf = (module: WorkspaceModule) => module.sidebarMaxSize ?? DEFAULT_SIDEBAR_MAX

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY
      if (aboveModule) {
        const clamped = Math.min(
          Math.max(delta, minOf(aboveModule) - aboveHeight),
          belowHeight - minOf(belowModule),
        )
        setSizes((previous) => ({
          ...previous,
          [aboveModule.id]: Math.min(
            Math.max(aboveHeight + clamped, minOf(aboveModule)),
            maxOf(aboveModule),
          ),
          [belowModule.id]: Math.min(
            Math.max(belowHeight - clamped, minOf(belowModule)),
            maxOf(belowModule),
          ),
        }))
        return
      }
      setSizes((previous) => ({
        ...previous,
        [belowModule.id]: Math.min(
          Math.max(belowHeight + delta, minOf(belowModule)),
          maxOf(belowModule),
        ),
      }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="ws-sidebar-stack">
      {modules.map((module, index) => {
        const expanded = expandedIds.includes(module.id)
        const collapsedSize = module.collapsedSidebarSize ?? DEFAULT_COLLAPSED_SIZE
        const sidebarProps: ModuleSidebarProps = {
          collapsed: !expanded,
          collapse: () => onToggle(module.id, false),
          expand: () => onToggle(module.id, true),
        }
        const style = expanded
          ? {
              flexGrow: sizes[module.id] ?? module.sidebarDefaultSize ?? DEFAULT_SIDEBAR_SIZE,
              flexShrink: 1,
              flexBasis: 0,
              minHeight: module.sidebarMinSize ?? DEFAULT_SIDEBAR_MIN,
            }
          : { flexGrow: 0, flexShrink: 0, flexBasis: collapsedSize }
        return (
          <Fragment key={module.id}>
            {expanded && index > 0 && expandedModules.length > 1 ? (
              <div
                className="ws-stack-gutter"
                role="separator"
                aria-orientation="horizontal"
                title={`拖动调整 ${module.title} 侧边栏高度`}
                onPointerDown={startDrag(module.id)}
              />
            ) : null}
            <section
              className={expanded ? 'ws-sidebar-section' : 'ws-sidebar-section ws-sidebar-section-collapsed'}
              style={style}
              ref={(element) => {
                sectionRefs.current[module.id] = element
              }}
            >
              <Slot name={sidebarSlotName(module.id)} className="ws-slot" />
              <ModuleHost
                module={module}
                sidebarProps={sidebarProps}
                workspaceVisible={workspaceVisibleIds.has(module.id)}
                statusVisible={expanded}
              />
            </section>
          </Fragment>
        )
      })}
    </div>
  )
}

/** 工作区里一个展开模块的列，宽度按模块独立记住。 */
function WorkspaceColumn({
  module,
  storageKey,
  index,
}: {
  module: WorkspaceModule
  storageKey: string
  index: number
}) {
  const [size, save] = useStoredSize(
    `${storageKey}:workspace:${module.id}`,
    DEFAULT_WORKSPACE_SIZE,
  )
  return (
    <Fragment>
      {index > 0 ? <Separator className="ws-separator" /> : null}
      <Panel
        id={module.id}
        className="ws-workspace-panel"
        defaultSize={size}
        minSize={DEFAULT_WORKSPACE_MIN}
        onResize={(panelSize) => save(panelSize.inPixels)}
      >
        <Slot name={workspaceSlotName(module.id)} className="ws-slot" />
      </Panel>
    </Fragment>
  )
}

/** 右侧集成控制面板：只列当前选中可用的操作，操作来自已启用模块。 */
function ControlPanel({ modules, onError }: { modules: WorkspaceModule[]; onError: (error: unknown) => void }) {
  const { selection } = useWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const items = modules.flatMap((module) =>
    (module.actions ?? []).map((action) => ({ module, action })),
  )
  const applicable = selection ? items.filter(({ action }) => action.appliesTo(selection)) : []
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
            const reason = selection ? (action.disabledReason?.(selection) ?? null) : null
            return (
              <button
                key={`${module.id}:${action.id}`}
                type="button"
                className="ws-action"
                disabled={Boolean(reason) || busy !== null}
                title={reason ?? undefined}
                onClick={() => {
                  if (!selection) return
                  if (action.confirm && !window.confirm(action.confirm)) return
                  void run(action.id, () => action.run(selection))
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

/** 工作区：宿主页面优先；否则按 profile 顺序并排展开模块的 Workspace。 */
function WorkspaceArea({
  modules,
  views,
  storageKey,
}: {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  storageKey: string
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
  if (modules.length === 0) {
    return (
      <div className="ws-placeholder">
        <span className="ws-placeholder-title">Work space</span>
        <span className="ws-placeholder-text">展开左侧任一模块的侧边栏以显示它的工作区。</span>
      </div>
    )
  }
  return (
    <Group orientation="horizontal" className="ws-workspace-group">
      {modules.map((module, index) => (
        <WorkspaceColumn key={module.id} module={module} storageKey={storageKey} index={index} />
      ))}
    </Group>
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
}

/** 一个 profile 的固定骨架：侧边栏堆叠 + 工作区 + 控制面板。profile 切换时整体重挂。 */
function Surface({ modules, views, profile, storageKey, status }: SurfaceProps) {
  const enabled = useMemo(
    () =>
      profile.modules
        .map((id) => modules.find((module) => module.id === id))
        .filter((module): module is WorkspaceModule => Boolean(module)),
    [modules, profile.modules],
  )
  const enabledKey = enabled.map((module) => module.id).join(',')

  const expandedKey = `${storageKey}:expanded`
  const [expandedIds, setExpandedIds] = useState<string[]>(() => {
    const stored = readStringList(expandedKey)
    if (stored) return stored.filter((id) => profile.modules.includes(id))
    const declared = enabled.filter((module) => module.defaultExpanded).map((module) => module.id)
    if (declared.length > 0) return declared
    return enabled[0] ? [enabled[0].id] : []
  })

  useEffect(() => {
    saveStringList(expandedKey, expandedIds)
  }, [expandedKey, expandedIds])

  // profile 或模块集合变化后，丢掉不再启用的展开项。
  useEffect(() => {
    setExpandedIds((previous) => {
      const next = previous.filter((id) => enabled.some((module) => module.id === id))
      return next.length === previous.length ? previous : next
    })
  }, [enabledKey, enabled])

  const onExpandedChange = useCallback((moduleId: string, expanded: boolean) => {
    setExpandedIds((previous) => {
      const has = previous.includes(moduleId)
      if (has === expanded) return previous
      return expanded ? [...previous, moduleId] : previous.filter((id) => id !== moduleId)
    })
  }, [])

  const { selection } = useWorkspace()
  const view = findView(views, selection)
  const expandedModules = enabled.filter((module) => expandedIds.includes(module.id))
  const visibleModules = view ? [] : expandedModules
  const visibleIds = new Set(visibleModules.map((module) => module.id))

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
              expandedIds={expandedIds}
              onToggle={onExpandedChange}
              storageKey={storageKey}
              workspaceVisibleIds={visibleIds}
            />
          </Panel>
          <Separator className="ws-separator" />
          <Panel id="workspace" className="ws-workspace" minSize={320}>
            <WorkspaceArea modules={visibleModules} views={views} storageKey={storageKey} />
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
            <ControlPanel modules={enabled} onError={console.error} />
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
          <StatusSegments modules={expandedModules} selection={selection} />
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
  storageKey,
}: Required<Pick<WorkspaceShellProps, 'storageKey'>> & WorkspaceShellProps) {
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
