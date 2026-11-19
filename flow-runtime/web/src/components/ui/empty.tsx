import * as React from 'react'
import { cn } from '../../lib/utils'

/** 空状态：列表没有数据时占位，保持与卡片一致的边框。 */
export function Empty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
export function EmptyMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('inline-grid size-10 place-items-center rounded-lg bg-elevated [&_svg]:size-5', className)}
      {...props}
    />
  )
}
export function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('font-medium text-foreground', className)} {...props} />
}
export function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap items-center justify-center gap-2', className)} {...props} />
}
