import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-primary-foreground shadow',
        secondary: 'border-transparent bg-elevated text-txt',
        destructive: 'border-err/40 bg-err/10 text-err',
        outline: 'border-line text-txt',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export interface StatusPillProps {
  status: string
  className?: string
}

const statusStates: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'neutral' },
  pending: { label: '待执行', tone: 'neutral' },
  running: { label: '运行中', tone: 'info' },
  waiting: { label: '待确认', tone: 'warn' },
  waiting_approval: { label: '待审批', tone: 'warn' },
  succeeded: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'err' },
  cancelled: { label: '已取消', tone: 'neutral' },
  released: { label: '已释放', tone: 'neutral' },
  active: { label: '可用', tone: 'ok' },
  draft: { label: '草稿', tone: 'neutral' },
  ready: { label: '就绪', tone: 'ok' },
  disabled: { label: '已停用', tone: 'neutral' },
  connected: { label: '已连接', tone: 'ok' },
}

/** 业务状态标签，文案与配色沿用旧映射。 */
export function StatusPill({ status, className }: StatusPillProps) {
  const state = statusStates[status] ?? { label: status, tone: 'neutral' }
  return (
    <span className={cn('status-pill', `status-${state.tone}`, className)}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {state.label}
    </span>
  )
}

export { Badge }
