import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { PageHeader } from '@/shared/ui/page-header'
import { ChatMessages } from './ChatMessages'
import { ChatSidebar } from './ChatSidebar'
import { PromptForm } from './PromptForm'
import { useChatStore } from './store'

function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="mb-1 rounded-xl border border-line bg-base p-3 text-txt3">
        <Icon name="chat" size={24} />
      </span>
      <h2 className="font-semibold text-txt">开始一段新对话</h2>
      <p className="max-w-md text-sm leading-6 text-txt3">演示助手会读取当前工作流与运行记录，并按本地模板生成回复，不会调用任何模型。</p>
      {onCreate ? <Button className="mt-3" variant="primary" icon="plus" onClick={onCreate}>新建对话</Button> : null}
    </div>
  )
}

/** 对话页：左侧会话列表，右侧消息流与输入区，路由参数决定当前会话。 */
export default function ChatView() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const sessions = useChatStore((state) => state.sessions)
  const currentId = useChatStore((state) => state.currentId)
  const loading = useChatStore((state) => state.loading)
  const streaming = useChatStore((state) => state.streaming)
  const error = useChatStore((state) => state.error)
  const loadSessions = useChatStore((state) => state.loadSessions)
  const selectSession = useChatStore((state) => state.selectSession)
  const createSession = useChatStore((state) => state.createSession)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const send = useChatStore((state) => state.send)
  const stop = useChatStore((state) => state.stop)
  const regenerate = useChatStore((state) => state.regenerate)

  useEffect(() => { void loadSessions() }, [loadSessions])
  // 路由是当前会话的唯一来源：直接进入会话地址时同步到 store，回到 /chat 时清空选中。
  useEffect(() => { selectSession(sessionId ?? null) }, [sessionId, selectSession])
  // 离开页面时中止在途消息流，避免后台继续写入属于已关闭视图的状态。
  useEffect(() => () => { stop() }, [stop])

  const active = sessionId ? sessions.find((session) => session.id === sessionId) : undefined
  const canRegenerate = Boolean(active) && !streaming && Boolean(active?.messages.some((message) => message.role === 'assistant'))
  const canResend = Boolean(active?.messages.some((message) => message.role === 'user'))

  /** 错误条的重试入口：有用户消息时重发上一条，否则重新加载会话列表。 */
  async function retry() {
    if (canResend) { await regenerate(); return }
    await loadSessions()
  }

  async function create() {
    setCreating(true)
    const session = await createSession()
    setCreating(false)
    if (session) navigate(`/chat/${session.id}`)
  }

  async function remove(id: string) {
    if (await deleteSession(id)) navigate('/chat', { replace: true })
  }

  return (
    <div className="page-stack page-stack-fill">
      <PageHeader title="对话" description="就当前工作流与运行记录向助手提问。" />
      <div className="panel flex min-h-[520px] min-w-0 flex-col overflow-hidden lg:min-h-0 lg:flex-1 lg:flex-row">
        <ChatSidebar
          sessions={sessions}
          currentId={currentId}
          loading={loading}
          error={sessions.length ? '' : error}
          creating={creating}
          onCreate={() => { void create() }}
          onRetry={() => { void loadSessions() }}
          onSelect={(id) => { navigate(`/chat/${id}`) }}
          onDelete={(id) => { void remove(id) }}
        />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-txt">{active ? active.title : '未选择会话'}</h2>
              <p className="mt-0.5 truncate text-xs text-txt3">回复由本地演示模板生成，未调用模型</p>
            </div>
            {canRegenerate ? (
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => { void regenerate() }}>重新生成</Button>
            ) : null}
          </header>
          {active ? (
            <ChatMessages session={active} streaming={streaming} />
          ) : (
            <EmptyState onCreate={() => { void create() }} />
          )}
          {error && sessions.length ? (
            <div role="alert" className="flex min-w-0 items-center justify-between gap-2 border-t border-line px-4 py-2">
              <p className="min-w-0 text-sm text-err">{error}</p>
              <Button size="sm" variant="ghost" icon="refresh" disabled={streaming} onClick={() => { void retry() }}>
                {canResend ? '重新发送' : '重新加载'}
              </Button>
            </div>
          ) : null}
          <PromptForm disabled={!active} streaming={streaming} onSend={(text) => { void send(text) }} onStop={stop} />
        </section>
      </div>
    </div>
  )
}
