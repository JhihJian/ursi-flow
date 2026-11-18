'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/shared/lib/utils'

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('inline-flex h-9 items-center justify-center rounded-lg bg-elevated p-1 text-txt3', className)}
      {...props}
    />
  )
})

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-base transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-surface data-[state=active]:text-txt data-[state=active]:shadow',
        className,
      )}
      {...props}
    />
  )
})

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('mt-2 ring-offset-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      {...props}
    />
  )
})

export interface TabItem {
  id: string
  label: React.ReactNode
  /** 视觉弱化并加删除线，点击只触发 onDisabledClick。 */
  ghosted?: boolean
  disabled?: boolean
}

export interface TabBarProps {
  tabs: TabItem[]
  value: string
  onValueChange?: (value: string) => void
  onDisabledClick?: (id: string) => void
  className?: string
  ariaLabel?: string
}

/**
 * 旧 AppTabs 的等价实现：下划线指示器、方向键/Home/End 切换，
 * 弱化标签点击只通知不切换。
 */
export function TabBar({ tabs, value, onValueChange, onDisabledClick, className, ariaLabel }: TabBarProps) {
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = React.useState({ opacity: '0', transform: 'translateX(0)', width: '0px' })

  const updateIndicator = React.useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const active = track.querySelector<HTMLElement>('[data-tab-active="true"]')
    if (!active) {
      setIndicator({ opacity: '0', transform: 'translateX(0)', width: '0px' })
      return
    }
    setIndicator({
      opacity: '1',
      transform: `translateX(${active.offsetLeft + 8}px)`,
      width: `${Math.max(0, active.offsetWidth - 16)}px`,
    })
  }, [])

  React.useLayoutEffect(() => { updateIndicator() }, [updateIndicator, value, tabs])
  React.useEffect(() => {
    window.addEventListener('resize', updateIndicator)
    return () => { window.removeEventListener('resize', updateIndicator) }
  }, [updateIndicator])

  function select(tab: TabItem) {
    if (tab.ghosted || tab.disabled) {
      onDisabledClick?.(tab.id)
      return
    }
    onValueChange?.(tab.id)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const enabled = tabs.filter((tab) => !tab.disabled && !tab.ghosted)
    if (!enabled.length) return
    event.preventDefault()
    const current = enabled.findIndex((tab) => tab.id === value)
    const index = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabled.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
    const next = enabled[index]
    if (!next) return
    onValueChange?.(next.id)
    window.setTimeout(() => {
      trackRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]')?.focus()
    }, 0)
  }

  return (
    <div className={cn('scroll-area -mx-1 overflow-x-auto', className)}>
      <div
        ref={trackRef}
        role="tablist"
        aria-label={ariaLabel}
        className="relative flex min-w-max items-center gap-1 border-b border-line px-1"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = value === tab.id && !tab.ghosted && !tab.disabled
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={value === tab.id}
              aria-disabled={tab.ghosted || tab.disabled ? 'true' : undefined}
              tabIndex={active ? 0 : -1}
              data-tab-active={active ? 'true' : undefined}
              className={cn(
                'relative -mb-px shrink-0 px-3.5 py-2.5 text-sm font-medium transition',
                tab.ghosted || tab.disabled
                  ? 'cursor-not-allowed text-txt3/40 line-through'
                  : active
                    ? 'text-txt'
                    : 'text-txt3 hover:text-txt2',
              )}
              onClick={() => select(tab)}
            >
              {tab.label}
            </button>
          )
        })}
        <span
          className="app-tabs-indicator pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-accent"
          data-testid="app-tabs-indicator"
          style={indicator}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
