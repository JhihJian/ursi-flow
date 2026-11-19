import { type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

export interface PageHeaderProps {
  title: string
  description?: string
  /** 右侧操作区。 */
  actions?: ReactNode
  className?: string
}

/** 页面标题条：标题、说明与操作压在一行，把纵向空间留给业务内容。 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <h1 className="shrink-0 text-xl font-semibold tracking-tight text-txt">{title}</h1>
      {description ? <p className="min-w-0 flex-1 truncate text-xs text-txt3">{description}</p> : null}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
