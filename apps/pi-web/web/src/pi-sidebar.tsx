import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { usePi } from './pi-context'
import { usePiNav } from './pi-nav'
import type { SessionRow } from './views/sessions/api'
import { HomeList } from './views/config/components/Nav'
import { SessionsPanel } from './views/sessions/components/SessionsPanel'

/**
 * Pi 模块的唯一侧栏，从上到下：home 管理区、目录与会话列表、底部按钮排。
 *
 * 折叠时整段收成窄条（SidebarFrame 负责），内部的组展开状态是瞬时状态，丢了不要紧。
 */
export function PiSidebar({ collapsed, collapse, expand }: ModuleSidebarProps): React.ReactNode {
  const { home, loading, error } = usePi()
  const { page, cwd, setCwd, toDraft, toSession, toConfig } = usePiNav()

  const activeFile = page.kind === 'session' ? page.sessionFile : null
  const open = (row: SessionRow) => {
    setCwd(row.cwd)
    toSession(row.path)
  }

  const items = home ? [{ label: 'home', value: home.name }] : []

  return (
    <SidebarFrame
      title="Pi"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={items}
    >
      <div className="pi-sidebar pisess">
        {loading ? <p className="sidebar-note">加载 pi home…</p> : null}
        {error ? <p className="sidebar-note error">{error}</p> : null}
        <div className="pi-sidebar-homes">
          <div className="pi-manager-root">
            <HomeList />
          </div>
        </div>
        <div className="pi-sidebar-sessions">
          <SessionsPanel activeFile={activeFile} cwd={cwd} onPickDir={setCwd} onOpen={open} />
        </div>
        <div className="pi-sidebar-foot">
          <button type="button" className="pichat-button is-sm" onClick={toDraft}>
            + 新对话
          </button>
          <button type="button" className="rail-toggle" title="配置" aria-label="配置" onClick={toConfig}>
            ⚙ 配置
          </button>
        </div>
      </div>
    </SidebarFrame>
  )
}
