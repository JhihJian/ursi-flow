import { useEffect, useState } from 'react'
import { useAppStore } from './store/app-store'
import { SECTIONS, Sidebar, type SectionId } from './components/Sidebar'
import { HomeBar } from './components/HomeBar'
import { GeneralSection } from './components/sections/GeneralSection'
import { ProvidersSection } from './components/sections/ProvidersSection'
import { ModelsSection } from './components/sections/ModelsSection'
import { SkillsSection } from './components/sections/SkillsSection'
import { AgentsSection } from './components/sections/AgentsSection'
import { PluginsSection } from './components/sections/PluginsSection'
import { McpSection } from './components/sections/McpSection'
import { EmptyState, ErrorBanner, Loading } from './components/ui'

/**
 * 应用骨架：HomeBar + Sidebar + 分区内容。
 * home 变化时整个内容区 key={home} 强制重挂载（所有分区状态随之重置）。
 * 已挂载过的分区保持挂载（hidden 切换），保留各自的滚动与表单状态。
 */

const STORAGE_KEY = 'pi-manager.section'

function loadInitialSection(): SectionId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as SectionId | null
    if (saved && SECTIONS.some((s) => s.id === saved)) return saved
  } catch {
    /* ignore */
  }
  return 'general'
}

export function App() {
  const homePath = useAppStore((s) => s.homePath)
  const homeValid = useAppStore((s) => s.homeValid)
  const homeChecking = useAppStore((s) => s.homeChecking)
  const homeError = useAppStore((s) => s.homeError)
  const initHome = useAppStore((s) => s.initHome)
  const footer = useAppStore((s) => s.footer)
  const [section, setSection] = useState<SectionId>(loadInitialSection)
  const [mounted, setMounted] = useState<Set<SectionId>>(() => new Set([loadInitialSection()]))

  useEffect(() => {
    void initHome()
  }, [initHome])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, section)
    } catch {
      /* ignore */
    }
    setMounted((prev) => {
      if (prev.has(section)) return prev
      const next = new Set(prev)
      next.add(section)
      return next
    })
  }, [section])

  if (homeChecking && !homePath) return <Loading label="探测默认 pi home" />
  if (!homePath) {
    return (
      <>
        <HomeBar />
        <main className="app-main">
          <EmptyState title="没有设置 pi home" hint={homeError ?? '点击右上角「切换 home」输入绝对路径。'} />
        </main>
      </>
    )
  }
  if (homeValid === false) {
    return (
      <>
        <HomeBar />
        <main className="app-main">
          <EmptyState
            title="该路径不是有效的 pi home"
            hint={`${homePath} 下没有 settings.json。确认目录后重新切换。`}
          />
        </main>
      </>
    )
  }

  return (
    <>
      <HomeBar />
      <div className="app-main">
        <Sidebar active={section} onSelect={setSection} />
        <main className="config-detail" key={homePath}>
          {SECTIONS.map(({ id }) => {
            if (!mounted.has(id)) return null
            return (
              <div key={id} hidden={id !== section} style={id !== section ? { display: 'none' } : undefined}>
                <SectionContent id={id} home={homePath} />
              </div>
            )
          })}
        </main>
      </div>
      <footer className="status-footer">
        <span className={`footer-msg ${footer.kind === 'ok' ? 'ok' : footer.kind === 'error' ? 'error' : ''}`}>
          {footer.message || `${homePath}`}
        </span>
        <span className="spacer" />
        <span>只读通道任意来源 · 写操作限本机 · 凭据永不回显</span>
      </footer>
    </>
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
