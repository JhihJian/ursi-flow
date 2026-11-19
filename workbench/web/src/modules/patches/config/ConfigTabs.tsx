import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'

export interface ConfigTabItem<K extends string> {
  id: K
  label: string
  /** 计数徽标，0 时不显示。 */
  count?: number
}

export interface ConfigTabsProps<K extends string> {
  tabs: ConfigTabItem<K>[]
  value: K
  onChange: (id: K) => void
  ariaLabel: string
  className?: string
}

/**
 * 紧凑分区标签：8px 高、13px 字号，下划线跟随选中项。
 * 与共享 TabBar 的差别只在密度，交互（方向键、Home/End）保持一致。
 */
export function ConfigTabs<K extends string>({ tabs, value, onChange, ariaLabel, className }: ConfigTabsProps<K>) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState({ opacity: '0', transform: 'translateX(0)', width: '0px' })

  const updateIndicator = useCallback(() => {
    const active = trackRef.current?.querySelector<HTMLElement>('[data-config-tab-active="true"]')
    if (!active) {
      setIndicator({ opacity: '0', transform: 'translateX(0)', width: '0px' })
      return
    }
    setIndicator({
      opacity: '1',
      transform: `translateX(${active.offsetLeft + 6}px)`,
      width: `${Math.max(0, active.offsetWidth - 12)}px`,
    })
  }, [])

  useLayoutEffect(() => { updateIndicator() }, [updateIndicator, value, tabs])
  useEffect(() => {
    window.addEventListener('resize', updateIndicator)
    return () => { window.removeEventListener('resize', updateIndicator) }
  }, [updateIndicator])

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = tabs.findIndex(tab => tab.id === value)
    const index = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const next = tabs[index]
    if (!next) return
    onChange(next.id)
    window.setTimeout(() => {
      trackRef.current?.querySelector<HTMLElement>('[data-config-tab-active="true"]')?.focus()
    }, 0)
  }

  return (
    <div className={cn('scroll-area -mx-1 overflow-x-auto', className)}>
      <div
        ref={trackRef}
        role="tablist"
        aria-label={ariaLabel}
        className="relative flex min-w-max items-center gap-0.5 px-1"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === value
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-config-tab={tab.id}
              data-config-tab-active={active ? 'true' : undefined}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] transition-colors',
                active ? 'font-medium text-txt' : 'text-txt3 hover:text-txt2',
              )}
              onClick={() => onChange(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count ? (
                <span
                  className={cn(
                    'min-w-[18px] rounded-full px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums',
                    active ? 'bg-accent-dim text-accent-2' : 'bg-elevated text-txt3',
                  )}
                >{tab.count}</span>
              ) : null}
            </button>
          )
        })}
        <span
          className="app-tabs-indicator pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-accent"
          data-testid="config-tabs-indicator"
          style={indicator}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
