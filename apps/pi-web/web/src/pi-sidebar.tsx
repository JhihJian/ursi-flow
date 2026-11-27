import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import { useMemo } from 'react'
import { usePi } from './pi-context'
import { usePiNav } from './pi-nav'
import { useChatController } from './views/chat/chat-context'
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

  // 会话页指向的会话 id：侧栏高亮按它比对，路由键只用 sessionId。
  const activeId = page.kind === 'session' ? page.id : null
  // 会话页的入口只有这一个：点行。右键菜单不再重复给「打开」。
  const open = (row: SessionRow) => {
    setCwd(row.cwd)
    toSession(row.id)
  }
  // 释放运行时是 chat 的动作、会话行的菜单项：组合根把两端接上，子模块不互相 import。
  const { chats, evict } = useChatController()
  const assembledIds = useMemo(() => new Set(chats.map((chat) => chat.sessionId)), [chats])

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
          <SessionsPanel
            activeId={activeId}
            cwd={cwd}
            onPickDir={setCwd}
            onOpen={open}
            onEvict={(id) => void evict(id)}
            assembledIds={assembledIds}
          />
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
