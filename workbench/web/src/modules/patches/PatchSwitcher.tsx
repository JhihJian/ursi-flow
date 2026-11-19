import { useEffect, useId, useRef, useState } from 'react'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import type { Patch } from './api'

export interface PatchSwitchListProps {
  patches: Patch[]
  activeId: string
  loading?: boolean
  error?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onRetry?: () => void
}

/** 包列表本身不含路由，切换器下拉和窄屏抽屉共用。 */
export function PatchSwitchList({
  patches,
  activeId,
  loading = false,
  error = '',
  onSelect,
  onCreate,
  onRetry,
}: PatchSwitchListProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="patch-switch-list">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-txt3">全部包</span>
        <Button size="sm" variant="ghost" icon="plus" onClick={onCreate}>新建</Button>
      </div>
      {error ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs text-err">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {onRetry ? <Button size="sm" variant="ghost" onClick={onRetry}>重试</Button> : null}
        </div>
      ) : null}
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-1">
        {loading && patches.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-txt3" role="status">正在加载包列表…</p>
        ) : patches.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-txt3">{error ? '暂时没有可切换的包。' : '还没有包，先新建一个。'}</p>
        ) : (
          <ul className="space-y-0.5">
            {patches.map((patch) => {
              const active = patch.id === activeId
              return (
                <li key={patch.id}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(patch.id)}
                    className={cn(
                      'flex w-full min-w-0 flex-col rounded-md px-3 py-2 text-left transition',
                      active ? 'bg-accent-dim text-accent-2' : 'text-txt2 hover:bg-elevated hover:text-txt',
                    )}
                  >
                    <span className="w-full truncate text-[13px] font-medium">{patch.name}</span>
                    <span className="mt-0.5 w-full truncate font-mono text-[11px] text-txt3">{patch.id}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export interface PatchSwitcherProps extends Omit<PatchSwitchListProps, 'onSelect'> {
  label: string
  className?: string
  onSelect: (id: string) => void
}

/** 桌面操作区的包切换入口：触发按钮加浮层，行为与 AgentStudio 的名称切换接近。 */
export function PatchSwitcher({
  label,
  className,
  onSelect,
  onCreate,
  ...list
}: PatchSwitcherProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelId = `patch-switcher-${useId().replace(/:/g, '')}`

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function select(id: string) {
    setOpen(false)
    onSelect(id)
  }

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)} data-testid="patch-switcher">
      <button
        ref={triggerRef}
        type="button"
        data-testid="patch-switcher-trigger"
        className="inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-[13px] font-medium text-txt transition hover:bg-overlay"
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevron-down" size={14} className={cn('shrink-0 text-txt3 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="切换包"
          data-testid="patch-switcher-panel"
          className="absolute left-0 top-full z-50 mt-1.5 flex max-h-[min(440px,calc(100dvh-160px))] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-card"
        >
          <PatchSwitchList {...list} onSelect={select} onCreate={() => { setOpen(false); onCreate() }} />
        </div>
      ) : null}
    </div>
  )
}
