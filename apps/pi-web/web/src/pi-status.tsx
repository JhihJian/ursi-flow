import { usePi } from './pi-context'
import { usePiNav } from './pi-nav'
import { useChatController } from './views/chat/chat-context'
import { useSessionsController } from './views/sessions/sessions-context'

/** 状态栏：home 与当前页面的摘要。运行中数量在侧栏脚注已有，这里不重复。 */
export function PiStatus() {
  const { home, homePath, loading } = usePi()
  const { page } = usePiNav()
  const { active } = useChatController()
  const { listing } = useSessionsController()

  const name = home?.name ?? (homePath ? homePath.split('/').slice(-2).join('/') : '未选 home')

  if (loading) return <span>Pi · 加载中</span>
  if (!homePath) return <span>Pi · 未选择 pi home</span>

  if (page.kind === 'session') {
    if (page.id === null) {
      const total = listing ? String(listing.sessions.length) : '—'
      return (
        <span>
          {name} · 新对话 · 会话 {total}
        </span>
      )
    }
    if (!active) return <span>{name} · 会话</span>
    const state = active.state === 'running' ? '运行中' : active.state === 'error' ? '出错' : '空闲'
    return (
      <span>
        {name} · {state}
        {active.model ? ` · ${active.model}` : ''}
      </span>
    )
  }

  if (page.kind === 'config') {
    return <span>{name} · 配置</span>
  }

  return <span>{name}</span>
}
