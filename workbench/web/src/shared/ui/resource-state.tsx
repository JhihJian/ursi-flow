import { type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'
import { Button } from './button'
import { Icon } from './icon'

export interface ResourceStateProps {
  loading?: boolean
  error?: unknown
  empty?: boolean
  title?: string
  description?: string
  onRetry?: () => void
  retryLabel?: string
  /** 空态下的补充操作。 */
  children?: ReactNode
  className?: string
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '请检查网络连接后重试。'
}

/** 资源加载三态：加载骨架、可重试错误、空结果，文案与结构沿用旧组件。 */
export function ResourceState({
  loading = false,
  error,
  empty = false,
  title,
  description,
  onRetry,
  retryLabel = '重新加载',
  children,
  className,
}: ResourceStateProps) {
  const hasError = Boolean(error)

  if (loading) {
    return (
      <section className={cn('panel p-6', className)} role="status" aria-busy="true" aria-label="正在加载">
        <span className="sr-only">正在加载，请稍候。</span>
        <div aria-hidden="true" className="space-y-4">
          <div className="skeleton h-5 w-1/3" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-4 border-t border-line pt-4">
              <div className="skeleton h-9 w-9 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  if (hasError) {
    return (
      <section className={cn('panel flex flex-col items-center px-6 py-12 text-center', className)} role="alert">
        <span className="mb-4 rounded-xl bg-err/10 p-3 text-err">
          <Icon name="warning" size={24} />
        </span>
        <h2 className="font-semibold text-txt">{title || '暂时无法加载'}</h2>
        <p className="mt-2 max-w-md break-words text-sm leading-6 text-txt3">{description || errorText(error)}</p>
        <Button className="mt-5" icon="refresh" onClick={onRetry}>
          {retryLabel}
        </Button>
      </section>
    )
  }

  if (empty) {
    return (
      <section className={cn('panel flex flex-col items-center px-6 py-14 text-center', className)} role="status">
        <span className="mb-4 rounded-xl border border-line bg-base p-3 text-txt3">
          <Icon name="folder" size={25} />
        </span>
        <h2 className="font-semibold text-txt">{title || '暂无内容'}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-txt3">{description || '内容会在创建后显示在这里。'}</p>
        {children ? <div className="mt-5">{children}</div> : null}
      </section>
    )
  }

  return null
}
