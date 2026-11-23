// Adapted from Vercel AI Elements (Apache-2.0). See PROVENANCE.md.
import type { ComponentProps, ReactNode } from 'react'
import { StickToBottom } from 'use-stick-to-bottom'
import { cn } from '@/shared/lib/utils'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={cn('relative min-h-0 min-w-0 flex-1 overflow-hidden', className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, scrollClassName, ...props }: ConversationContentProps) {
  return (
    <StickToBottom.Content
      className={cn('flex min-h-full min-w-0 flex-col gap-6 p-4', className)}
      scrollClassName={cn('overflow-y-auto', scrollClassName)}
      {...props}
    />
  )
}

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description,
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div className={cn('flex w-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center', className)} {...props}>
      {children ?? (
        <>
          {icon && <div className="text-txt3">{icon}</div>}
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-txt">{title}</h3>
            {description && <p className="text-sm text-txt3">{description}</p>}
          </div>
        </>
      )}
    </div>
  )
}
