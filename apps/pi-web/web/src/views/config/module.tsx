import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../pi-store'
import { SECTIONS, type SectionId } from './components/Nav'
import { GeneralSection } from './components/sections/GeneralSection'
import { ModelsSection } from './components/sections/ModelsSection'
import { SkillsSection } from './components/sections/SkillsSection'
import { AgentsSection } from './components/sections/AgentsSection'
import { PluginsSection } from './components/sections/PluginsSection'
import { McpSection } from './components/sections/McpSection'
import { EmptyState, ErrorBanner, ConfirmDialogHost } from './components/ui'

/**
 * 配置页：六个分区与各自的表单。分区导航在侧栏顶部的 home 管理区下面，
 * 内容在工作区；home 真源在 pi-store，这里只管「当前在哪个分区」。
 */

interface ManagerNav {
  section: SectionId
  setSection: (next: SectionId) => void
}

const NavContext = createContext<ManagerNav | null>(null)

export function useManagerNav(): ManagerNav {
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

export function ManagerProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [section, setSection] = useState<SectionId>(() => loadSection(storageKey))

  // home 探测由组合根的 PiProvider 负责，这里不再调 initHome。

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

function SectionContent({ id, home }: { id: SectionId; home: string }) {
  switch (id) {
    case 'general':
      return <GeneralSection home={home} />
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

export function ManagerWorkspace() {
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
      {/* 应用内确认框宿主：window.confirm 的替代品，全局单例。 */}
      <ConfirmDialogHost />
      {blocked ? (
        <div className="config-section-host">
          <EmptyState title={blocked.title} hint={blocked.hint} />
        </div>
      ) : (
        SECTIONS.map(({ id }) => {
          if (!mounted.has(id)) return null
          return (
            <div key={id} hidden={id !== section} className="config-section-host">
              <SectionContent id={id} home={homePath} />
            </div>
          )
        })
      )}
    </main>
  )
}
