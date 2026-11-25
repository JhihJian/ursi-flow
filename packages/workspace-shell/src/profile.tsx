import { Fragment, type ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import type {
  WorkspaceModule,
  WorkspaceProfile,
  WorkspaceRegionSpec,
  WorkspaceView,
} from './contracts'
import { ModuleRegionItem } from './module'
import { WorkspaceRegionBody, ActionsRegionBody } from './region-panel'
import './shell.css'

/** 区域默认宽度：只在多区域 profile 的根布局生效。 */
const REGION_DEFAULT_SIZE = 720

/** 区域条目的 Panel id：把 profile、区域都编进 id，天然跨 profile 唯一。 */
function panelId(profileId: string, regionId: string, item: WorkspaceRegionSpec['items'][number]): string {
  if (item.type === 'module') return `${profileId}:${regionId}:m:${item.moduleId}`
  return `${profileId}:${regionId}:${item.type}`
}

interface RegionItemViewArgs {
  modules: WorkspaceModule[]
  views: WorkspaceView[]
  vertical: boolean
  /** 模块条目用：区域 Group 里的 Panel id。 */
  panelId: string
}

function renderRegionItem(item: WorkspaceRegionSpec['items'][number], args: RegionItemViewArgs): ReactNode {
  if (item.type === 'workspace') return <WorkspaceRegionBody modules={args.modules} views={args.views} />
  if (item.type === 'actions') return <ActionsRegionBody modules={args.modules} />
  const module = args.modules.find((candidate) => candidate.id === item.moduleId)
  if (!module) {
    return (
      <div className="ws-placeholder">
        <span className="ws-placeholder-title">{item.moduleId}</span>
        <span className="ws-placeholder-text">Module is not registered.</span>
      </div>
    )
  }
  return <ModuleRegionItem module={module} panelId={args.panelId} vertical={args.vertical} />
}

interface ProfileRegionProps {
  region: WorkspaceRegionSpec
  profileId: string
  storageKey: string
  modules: WorkspaceModule[]
  views: WorkspaceView[]
}

/** 一个区域：多条目时可持久化子 Group，单条目时 Group 退化成单子元素。模块条目自带 Panel，其余由区域包 Panel。 */
export function ProfileRegion({ region, profileId, storageKey, modules, views }: ProfileRegionProps) {
  const vertical = (region.direction ?? 'vertical') === 'vertical'

  if (region.items.length === 0) return null

  // 每个区域自己的布局键：panelIds 随 profile 声明入键，组合变了库自动丢弃对不上的旧布局。
  const layout = useDefaultLayout({
    id: `${storageKey}:${profileId}:region:${region.id}`,
    panelIds: region.items.map((item) => panelId(profileId, region.id, item)),
  })
  return (
    <Group
      orientation={vertical ? 'vertical' : 'horizontal'}
      className={vertical ? 'ws-stack' : 'ws-row'}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {region.items.map((item, index) => {
        const id = panelId(profileId, region.id, item)
        const body = renderRegionItem(item, { modules, views, vertical, panelId: id })
        return (
          <Fragment key={id}>
            {index > 0 && <Separator className={vertical ? 'ws-separator-v' : 'ws-separator'} />}
            {item.type === 'module' ? (
              body
            ) : (
              <Panel id={id} className="ws-panel" minSize={120}>
                {body}
              </Panel>
            )}
          </Fragment>
        )
      })}
    </Group>
  )
}

interface ProfileSurfaceProps {
  profile: WorkspaceProfile
  storageKey: string
  modules: WorkspaceModule[]
  views: WorkspaceView[]
}

/** 一个 profile 的完整布局表面。key=profile.id 强制整体重挂，根布局按 profile 隔离。 */
export function ProfileSurface({ profile, storageKey, modules, views }: ProfileSurfaceProps) {
  const singleRegion = profile.regions.length === 1 ? profile.regions[0]! : null

  if (singleRegion) {
    return (
      <ProfileRegion
        key={profile.id}
        region={singleRegion}
        profileId={profile.id}
        storageKey={storageKey}
        modules={modules}
        views={views}
      />
    )
  }

  // 多区域：根横向 Group，区域缺省宽度来自声明或 REGION_DEFAULT_SIZE。
  const regionIds = profile.regions.map((region) => `${profile.id}:region:${region.id}`)
  return (
    <RootRegionGroup
      key={profile.id}
      profileId={profile.id}
      storageKey={storageKey}
      regionIds={regionIds}
      profile={profile}
      modules={modules}
      views={views}
    />
  )
}

interface RootRegionGroupProps {
  profile: WorkspaceProfile
  profileId: string
  storageKey: string
  regionIds: string[]
  modules: WorkspaceModule[]
  views: WorkspaceView[]
}

/** 多区域根 Group：区域条目用普通 Panel（内容自带折叠机制），区域缺省宽度来自声明或 REGION_DEFAULT_SIZE。 */
function RootRegionGroup({ profile, profileId, storageKey, regionIds, modules, views }: RootRegionGroupProps) {
  const layout = useDefaultLayout({
    id: `${storageKey}:${profileId}`,
    panelIds: regionIds,
  })
  return (
    <Group
      orientation="horizontal"
      className="ws-root ws-root-multi"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      {profile.regions.map((region, index) => {
        const id = `${profileId}:region:${region.id}`
        return (
          <Fragment key={id}>
            {index > 0 && <Separator className="ws-separator" />}
            <Panel
              id={id}
              className="ws-region"
              defaultSize={region.defaultSize ?? REGION_DEFAULT_SIZE}
              minSize={240}
            >
              <ProfileRegion
                region={region}
                profileId={profileId}
                storageKey={storageKey}
                modules={modules}
                views={views}
              />
            </Panel>
          </Fragment>
        )
      })}
    </Group>
  )
}

/** 标题栏 profile 切换器：原生 select，与现有 ws-settings 按钮同风格。 */
export function ProfileSwitcher({
  profiles,
  currentId,
  onChange,
}: {
  profiles: WorkspaceProfile[]
  currentId: string
  onChange: (profileId: string) => void
}) {
  return (
    <select
      className="ws-profile-select"
      value={currentId}
      aria-label="页面布局"
      onChange={(event) => onChange(event.target.value)}
    >
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.title}
        </option>
      ))}
    </select>
  )
}
