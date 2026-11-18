import { useEffect, useRef } from 'react'

import { cn } from '@/shared/lib/utils'
import type { ChatMessage, ChatPart, ChatSession } from '@/shared/api/types'
import { Icon } from '@/shared/ui/icon'
import { MarkdownContent } from '@/shared/ui/markdown-content'
import { StatusPill } from '@/shared/ui/status-pill'

function textOf(message: ChatMessage): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

function Part({ part }: { part: ChatPart }) {
  if (part.type === 'text') {
    return part.text ? <MarkdownContent content={part.text} className="min-w-0" /> : null
  }
  if (part.type === 'reasoning') {
    return (
      <details className="min-w-0 rounded-lg border border-line bg-elevated/30 px-3 py-2">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-txt3">
          <Icon name="brain" size={13} />
          推理过程
        </summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-txt2">{part.text}</p>
      </details>
    )
  }
  return (
    <details className="min-w-0 rounded-lg border border-line bg-elevated/30 px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-txt3">
        <Icon name="terminal" size={13} />
        工具调用 · {part.name}
        <StatusPill status={part.status} className="ml-1" />
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-txt2">
        {part.output || '演示环境没有返回工具输出。'}
      </p>
    </details>
  )
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex min-w-0 justify-end">
      <p className="max-w-[min(34rem,88%)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-elevated px-4 py-2.5 text-sm leading-6 text-txt">
        {textOf(message)}
      </p>
    </div>
  )
}

function AssistantMessage({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  return (
    <div className="min-w-0 space-y-3">
      {message.parts.map((part, index) => (
        <Part key={`${message.id}-${index}`} part={part} />
      ))}
      {streaming ? <p className="text-xs text-txt3">正在生成…</p> : null}
    </div>
  )
}

export interface ChatMessagesProps {
  session: ChatSession
  streaming: boolean
  className?: string
}

/** 消息流：用户气泡右对齐，助手消息铺满宽度并渲染 Markdown 与折叠块。 */
export function ChatMessages({ session, streaming, className }: ChatMessagesProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const last = session.messages.at(-1)

  // 消息数量或最后一条内容变化后贴到底部，保持最新片段可见。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [session.id, session.messages.length, last])

  return (
    <div ref={scrollerRef} className={cn('scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5', className)}>
      {session.messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <h3 className="font-semibold text-txt">开始一段新对话</h3>
          <p className="max-w-md text-sm leading-6 text-txt3">演示助手会读取当前工作流与运行记录，并按本地模板生成回复。</p>
        </div>
      ) : (
        <ol aria-label="消息记录" className="flex min-w-0 flex-col gap-5">
          {session.messages.map((message) => (
            <li key={message.id} className="min-w-0">
              {message.role === 'user' ? (
                <UserMessage message={message} />
              ) : (
                <AssistantMessage message={message} streaming={streaming && message.id === last?.id} />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
