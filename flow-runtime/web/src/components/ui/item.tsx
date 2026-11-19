import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

/** 列表项：图标 + 标题/说明 + 操作，作为列表页的统一骨架。 */
export function ItemGroup({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('flex w-full flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card', className)}
      {...props}
    />
  )
}

const row =
  'group/item flex w-full flex-wrap items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-elevated/50'

/**
 * 列表项。整行可点时用 asChild 包一个 Link：li 留在列表里维持分隔线，
 * 交互元素套在行内容上占满整行。
 */
export function Item({
  className,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<'li'> & { asChild?: boolean }) {
  if (asChild)
    return (
      <li>
        <Slot className={cn(row, className)} {...props}>
          {children}
        </Slot>
      </li>
    )
  return (
    <li className={cn(row, className)} {...props}>
      {children}
    </li>
  )
}

export function ItemMedia({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-grid size-8 shrink-0 place-items-center rounded-lg bg-accent-dim text-accent-2 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
}

export function ItemContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', className)} {...props} />
}

export function ItemTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('truncate font-medium text-foreground', className)} {...props} />
}

export function ItemDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('truncate text-xs text-muted-foreground', className)} {...props} />
}

export function ItemActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('ml-auto flex shrink-0 items-center gap-1.5', className)} {...props} />
}

export function ItemSeparator({ className, ...props }: React.ComponentProps<'li'>) {
  return <li role="separator" className={cn('h-px w-full bg-border', className)} {...props} />
}
