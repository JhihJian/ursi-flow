import { type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'

export interface PageHeaderProps {
  title: string
  description?: string
  icon?: string
  /** 右侧操作区。 */
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, icon, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-5', className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {icon ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-accent">
            <Icon name={icon} size={22} />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">{title}</h1>
          {description ? <p className="mt-1.5 max-w-2xl text-sm leading-6 text-txt3">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
