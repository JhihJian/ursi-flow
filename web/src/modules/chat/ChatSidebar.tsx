import { useMemo, useState } from 'react'

import { cn } from '@/shared/lib/utils'
import type { ChatSession } from '@/shared/api/types'
import { confirmAction } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'

function preview(session: ChatSession): string {
  const last = [...session.messages].reverse().find((message) => message.role === 'assistant') ?? session.messages.at(-1)
  if (!last) return '暂无消息'
  const text = last.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim()
  return text ? Array.from(text.replace(/\s+/g, ' ')).slice(0, 40).join('') : '暂无消息'
}

export interface ChatSidebarProps {
  sessions: ChatSession[]
  currentId: string | null
  loading: boolean
  /** 列表加载失败时的可重试错误文案。 */
  error?: string
  creating: boolean
  onCreate: () => void
  onRetry?: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

/** 会话列表：搜索、新建、删除与当前高亮，移动端折叠在对话上方。 */
export function ChatSidebar({ sessions, currentId, loading, error = '', creating, onCreate, onRetry, onSelect, onDelete }: ChatSidebarProps) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return sessions
    return sessions.filter((session) => `${session.title} ${preview(session)}`.toLowerCase().includes(keyword))
  }, [sessions, search])

  async function remove(session: ChatSession) {
    const accepted = await confirmAction({
      title: '删除会话？',
      description: `将删除「${session.title}」及其消息记录，删除后无法恢复。`,
      confirmLabel: '删除会话',
      danger: true,
    })
    if (accepted) onDelete(session.id)
  }

  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-b border-line lg:w-[264px] lg:border-b-0 lg:border-r">
      <button
        type="button"
        className="flex items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-txt lg:hidden"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className="inline-flex items-center gap-2">
          <Icon name="chat" size={16} />
          会话列表
        </span>
        <Icon name="chevron-down" size={14} className={open ? 'rotate-180' : undefined} />
      </button>
      <div className={cn('min-h-0 flex-col', open ? 'flex' : 'hidden', 'lg:flex lg:flex-1')}>
        <div className="flex items-center gap-2 px-3 pb-3 lg:pt-4">
          <span className="search-input flex-1">
            <Icon name="search" size={15} />
            <input
              type="search"
              aria-label="搜索会话"
              placeholder="搜索会话"
              value={search}
              onChange={(event) => { setSearch(event.target.value) }}
            />
          </span>
          <Button size="sm" variant="primary" icon="plus" loading={creating} onClick={onCreate}>新建</Button>
        </div>
        <div className="scroll-area max-h-[38dvh] min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 lg:max-h-none">
          {loading ? (
            <p className="empty-hint" role="status">正在加载会话…</p>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-5 py-10 text-center">
              <p className="max-w-full break-words text-sm leading-6 text-err">{error}</p>
              <Button size="sm" icon="refresh" onClick={onRetry}>重新加载</Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="empty-hint">{sessions.length ? '没有匹配的会话。' : '还没有会话，先新建一个。'}</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-1">
              {filtered.map((session) => {
                const active = session.id === currentId
                return (
                  <li key={session.id} className={cn('flex min-w-0 items-center gap-1 rounded-lg', active ? 'bg-accent-dim' : 'hover:bg-elevated/60')}>
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-3 py-2 text-left"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => { onSelect(session.id) }}
                    >
                      <span className="block truncate text-sm font-medium text-txt">{session.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-txt3">{preview(session)}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button h-7 w-7"
                      aria-label={`删除会话 ${session.title}`}
                      onClick={() => { void remove(session) }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <p className="border-t border-line px-3 py-2.5 text-xs text-txt3">共 {sessions.length} 个会话 · 演示数据</p>
      </div>
    </aside>
  )
}
