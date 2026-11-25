import { useEffect, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ModuleColumn } from './module'
import { ProfileSurface, ProfileSwitcher } from './profile'
import { WorkspaceRegionBody, ActionsRegionBody } from './region-panel'
import { useWorkspace, WorkspaceProvider } from './context'
import type { WorkspaceModule, WorkspaceShellProps, WorkspaceView } from './contracts'
import './shell.css'

/** 历史行为：单横向 Group 平铺全部模块 + workspace + actions，storageKey 直接做布局键。 */
function LegacySurface({
  modules,
  views,
  storageKey,
}: {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  storageKey: string
}) {
  const layout = useDefaultLayout({
    id: storageKey,
    panelIds: [...modules.map((module) => module.id), 'workspace', 'actions'],
  })
  return (
    <Group
      orientation="horizontal"
      className="ws-root"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {modules.map((module) => (
        <ModuleColumn key={module.id} module={module} />
      ))}
      <Panel id="workspace" className="ws-workspace" defaultSize={480} minSize={280}>
        <WorkspaceRegionBody modules={modules} views={views} />
      </Panel>
      <Separator className="ws-separator" />
      <Panel id="actions" className="ws-actions" defaultSize={260} minSize={200} maxSize={380}>
        <ActionsRegionBody modules={modules} />
      </Panel>
    </Group>
  )
}

/** 无 profiles 时的状态栏摘要。 */
function selectionSummary(
  modules: WorkspaceModule[],
  views: WorkspaceView[],
  selection: ReturnType<typeof useWorkspace>['selection'],
): string {
  if (!selection) return 'No selection'
  for (const module of modules) {
    if (module.selection?.kind === selection.kind) {
      return module.selection.summary(selection)
    }
  }
  for (const view of views) {
    if (view.kind === selection.kind) return view.summary(selection)
  }
  return selection.id
}

interface ShellProps extends WorkspaceShellProps {
  storageKey: string
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
}: ShellProps) {
  // 当前 profile 持久化在 `${storageKey}:profile`，与布局存储相互隔离。
  const [profileId, setProfileId] = useState<string | null>(() => {
    const saved = window.localStorage.getItem(`${storageKey}:profile`)
    return saved && profiles?.some((profile) => profile.id === saved) ? saved : null
  })
  const activeId = profileId ?? profiles?.[0]?.id ?? null
  const activeProfile = profiles?.find((profile) => profile.id === activeId) ?? null

  useEffect(() => {
    if (profileId) window.localStorage.setItem(`${storageKey}:profile`, `${profileId}`)
  }, [storageKey, profileId])

  const { selection } = useWorkspace()
  const summary = selectionSummary(modules, views, selection)

  return (
    <div className="ws-shell">
      <header className="ws-titlebar">
        <span className="ws-title">{title}</span>
        <div className="ws-titlebar-right">
          {profiles && profiles.length >= 2 && activeId ? (
            <ProfileSwitcher
              profiles={profiles}
              currentId={activeId}
              onChange={setProfileId}
            />
          ) : null}
          {settings ?? (onSettings ? (
            <button type="button" className="ws-settings" onClick={onSettings}>
              Settings
            </button>
          ) : null)}
        </div>
      </header>
      <div className="ws-body">
        {activeProfile ? (
          <ProfileSurface
            key={activeProfile.id}
            profile={activeProfile}
            storageKey={storageKey}
            modules={modules}
            views={views}
          />
        ) : (
          <LegacySurface modules={modules} views={views} storageKey={storageKey} />
        )}
      </div>
      <footer className="ws-statusbar">
        <span className="ws-status-selection">{summary}</span>
        <span className="ws-status-extra">{status}</span>
      </footer>
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
