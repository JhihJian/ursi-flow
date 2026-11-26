import { usePi } from './pi-context'
import { useChatController } from './views/chat/chat-context'
import { useSessionsController } from './views/sessions/sessions-context'

/**
 * 状态栏：一个模块只能声明一种 selection kind，三种实体并存时摘要无法静态映射，
 * 所以这里用组件按活动视图给出摘要。
 */
export function PiStatus() {
  const { view, home, homePath, loading } = usePi()
  const { active, chats } = useChatController()
  const { listing, selected } = useSessionsController()

  const name = home?.name ?? (homePath ? homePath.split('/').slice(-2).join('/') : '未选 home')

  if (loading) return <span>Pi · 加载中</span>
  if (!homePath) return <span>Pi · 未选择 pi home</span>

  if (view === 'chat') {
    const running = chats.filter((chat) => chat.state === 'running').length
    const state = active?.state === 'running' ? '运行中' : active ? '空闲' : '未开始'
    return (
      <span>
        {name} · 对话 {state}
        {running > 0 ? ` · ${running} 场在跑` : ''}
        {active?.model ? ` · ${active.model}` : ''}
      </span>
    )
  }

  if (view === 'sessions') {
    const total = listing ? String(listing.sessions.length) : '—'
    return (
      <span>
        {name} · 会话 {total}
        {selected ? ` · ${selected.projectName}` : ''}
      </span>
    )
  }

  return <span>{name} · 配置</span>
}
