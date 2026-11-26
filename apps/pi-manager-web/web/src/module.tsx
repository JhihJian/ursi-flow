import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SidebarFrame, useOptionalWorkspace, type ModuleSidebarProps, type WorkspaceModule } from '@ursi/workspace-shell'
import { api, configureApiBase } from './api/client'
import { useAppStore } from './store/app-store'
import { SECTIONS, Sidebar, type SectionId } from './components/Sidebar'
import { GeneralSection } from './components/sections/GeneralSection'
import { ProvidersSection } from './components/sections/ProvidersSection'
import { ModelsSection } from './components/sections/ModelsSection'
import { SkillsSection } from './components/sections/SkillsSection'
import { AgentsSection } from './components/sections/AgentsSection'
import { PluginsSection } from './components/sections/PluginsSection'
import { McpSection } from './components/sections/McpSection'
import { EmptyState, ErrorBanner } from './components/ui'

/**
 * 管理台作为工作台模块的入口。
 *
 * 独立站点（App.tsx）与模块共用同一批分区组件与 store；差别只在宿主：
 * 模块把 pi home 清单与分区导航放进侧边栏，把分区内容放进工作区，
 * 运行中会话的展示交给会话模块（管理台只提供运行态数据）。
 *
 * 本模块发布 `pi.home` 选中：home 是它的实体，store 里的 homePath 是真源，
 * 选中单向派生，与 pi-sessions 的 SelectionBridge 一致。
 */

export const PI_HOME_KIND = 'pi.home'

export interface PiManagerModuleOptions {
  /** 管理台接口前缀；独立入口不传（同源），工作台传 `/api/pi-manager`。 */
  apiBaseUrl?: string
  /** 分区状态的 localStorage 键前缀。 */
  storageKey?: string
  /** 在会话模块打开某个会话根；未注入时不出「打开会话」入口。 */
  openRootInSessions?: (root: string) => Promise<unknown>
}

interface ManagerNav {
  section: SectionId
  setSection: (next: SectionId) => void
}

const NavContext = createContext<ManagerNav | null>(null)

function useManagerNav(): ManagerNav {
  const value = useContext(NavContext)
  if (!value) throw new Error('useManagerNav 必须在 ManagerProvider 内使用')
  return value
}

function loadSection(storageKey: string): SectionId {
  try {
    const saved = localStorage.getItem(`${storageKey}:section`) as SectionId | null
    if (saved && SECTIONS.some((item) => item.id === saved)) return saved
  } catch {
    /* ignore */
  }
  return 'general'
}

function ManagerProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [section, setSection] = useState<SectionId>(() => loadSection(storageKey))
  const initHome = useAppStore((s) => s.initHome)

  // home 探测在独立入口与模块入口都要跑一次：store 是唯一真源。
  useEffect(() => {
    void initHome()
  }, [initHome])

  useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}:section`, section)
    } catch {
      /* ignore */
    }
  }, [section, storageKey])

  const value = useMemo<ManagerNav>(() => ({ section, setSection }), [section])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

/**
 * 把当前 home 发布成外壳的选中：store 为真源，这里只做单向派生。
 *
 * 只在 home 真的变化时发布一次；home 清单刷新不该把别的模块的选中抢过来。
 */
function SelectionBridge() {
  const homePath = useAppStore((s) => s.homePath)
  const homes = useAppStore((s) => s.homes)
  const workspace = useOptionalWorkspace()
  const select = workspace?.select
  const published = useRef<string | null>(null)
  const selectionKind = workspace?.selection?.kind ?? null

  useEffect(() => {
    if (!select) return
    const entry = homePath ? homes.find((home) => home.path === homePath) : null
    const next = homePath
      ? { kind: PI_HOME_KIND, id: entry?.id ?? homePath, label: entry?.name ?? homePath }
      : null
    const key = next ? `${next.kind}:${next.id}:${next.label}` : null
    if (key === published.current) return
    published.current = key
    if (next) {
      select(next)
      return
    }
    if (selectionKind === PI_HOME_KIND) select(null)
  }, [homePath, homes, select, selectionKind])

  return null
}

function ManagerSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const { section, setSection } = useManagerNav()
  const homes = useAppStore((s) => s.homes)
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)
  const refreshHomes = useAppStore((s) => s.refreshHomes)
  const current = homes.find((home) => home.path === homePath)

  return (
    <SidebarFrame
      title="Pi 配置"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={[
        { label: 'home', value: current?.name ?? '未选' },
        { label: '分区', value: SECTIONS.find((item) => item.id === section)?.label ?? '—' },
      ]}
      actions={
        <button type="button" className="rail-toggle" title="重新扫描 pi home" onClick={() => void refreshHomes()}>
          ↻
        </button>
      }
    >
      <div className="pi-manager-root manager-module-sidebar">
        <p className={`manager-home-line${homeValid === false ? ' invalid' : ''}`} title={homePath}>
          {homeChecking ? '校验中…' : null}
          {current ? <strong>{current.name}</strong> : null}
          <span>{homePath || '未设置 pi home'}</span>
        </p>
        <Sidebar active={section} onSelect={setSection} />
      </div>
    </SidebarFrame>
  )
}

function SectionContent({ id, home }: { id: SectionId; home: string }) {
  switch (id) {
    case 'general':
      return <GeneralSection home={home} />
    case 'providers':
      return <ProvidersSection home={home} />
    case 'models':
      return <ModelsSection home={home} />
    case 'skills':
      return <SkillsSection home={home} />
    case 'agents':
      return <AgentsSection home={home} />
    case 'plugins':
      return <PluginsSection home={home} />
    case 'mcp':
      return <McpSection home={home} />
    default:
      return <ErrorBanner message="未知分区" />
  }
}

function ManagerWorkspace() {
  const { section } = useManagerNav()
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeError = useAppStore((s) => s.homeError)
  // 已打开过的分区保持挂载，切回来时表单与滚动位置还在。
  const [mounted, setMounted] = useState<Set<SectionId>>(() => new Set([section]))

  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(section)) return prev
      const next = new Set(prev)
      next.add(section)
      return next
    })
  }, [section])

  const blocked = !homePath
    ? { title: '没有设置 pi home', hint: homeError ?? '在左侧 Pi home 列表点「+」输入绝对路径。' }
    : homeValid === false
      ? {
          title: '该路径不是有效的 pi home',
          hint: `${homePath} 下没有 settings.json。在左侧列表选另一个，或用「+」新增。`,
        }
      : null

  return (
    <main className="pi-manager-root config-detail manager-module-workspace" key={homePath}>
      {blocked ? (
        <EmptyState title={blocked.title} hint={blocked.hint} />
      ) : (
        SECTIONS.map(({ id }) => {
          if (!mounted.has(id)) return null
          return (
            <div key={id} hidden={id !== section} style={id !== section ? { display: 'none' } : undefined}>
              <SectionContent id={id} home={homePath} />
            </div>
          )
        })
      )}
    </main>
  )
}

/** 管理台模块工厂：pi home 清单 + 配置分区，运行中会话归会话模块。 */
export function createPiManagerModule(options: PiManagerModuleOptions = {}): WorkspaceModule {
  const storageKey = options.storageKey ?? 'pi-manager'
  configureApiBase(options.apiBaseUrl ?? '')

  const Provider = ({ children }: { children: ReactNode }) => (
    <ManagerProvider storageKey={storageKey}>
      <SelectionBridge />
      {children}
    </ManagerProvider>
  )

  const openRootInSessions = options.openRootInSessions

  return {
    id: 'pi-config',
    title: 'Pi 配置',
    Provider,
    Sidebar: ManagerSidebar,
    Workspace: ManagerWorkspace,
    context: {
      kind: PI_HOME_KIND,
      summary: (selection) => selection.label ?? selection.id,
    },
    keepMounted: true,
    minSidebarSize: 320,
    collapsedSidebarSize: 32,
    actions: openRootInSessions
      ? [
          {
            id: 'open-home-sessions',
            label: '在会话模块打开该 home 的会话',
            appliesTo: (selection) => selection?.kind === PI_HOME_KIND,
            run: async (selection, shell) => {
              const home = selection.id
              const homes = useAppStore.getState().homes
              const path = homes.find((entry) => entry.id === home)?.path ?? selection.id
              const disk = await api.getSessionDisk(path)
              await openRootInSessions(disk.root)
              shell.reveal('pi-sessions')
            },
            disabledReason: (_selection, shell) =>
              shell.enabled('pi-sessions') ? null : '会话模块未在当前 profile 中启用',
          },
        ]
      : [],
  }
}
