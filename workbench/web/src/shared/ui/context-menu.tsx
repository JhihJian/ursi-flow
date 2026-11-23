import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'
import type { MenuAnchor } from './menu-anchor'

export type ContextAction = {
  label: string
  icon: string
  run: () => void
  disabled?: boolean
  danger?: boolean
  hint?: string
}

export function ContextMenu({ anchor, label, actions, onClose }: {
  anchor: MenuAnchor; label: string; actions: readonly ContextAction[]; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const enabled = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8))}px`
    ;(enabled()[0] ?? menu).focus({ preventScroll: true })
  }, [anchor])

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('scroll', dismissOutside, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('scroll', dismissOutside, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  function closeAndRestoreFocus() {
    onClose()
    if (anchor.trigger?.isConnected) anchor.trigger.focus({ preventScroll: true })
  }

  return createPortal(<div ref={ref} tabIndex={-1} role="menu" aria-label={label}
    className="fixed z-[60] max-h-[calc(100dvh-16px)] w-max min-w-40 max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-line bg-surface p-1 shadow-card outline-none"
    style={{ left: 0, top: 0 }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.stopPropagation()
        if (event.key === 'Escape') event.preventDefault()
        closeAndRestoreFocus()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const items = enabled()
      if (!items.length) return
      const index = items.findIndex(item => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
      items[next]?.focus()
    }}>
    {actions.map(({ label, icon, run, disabled, danger, hint }) => <button key={label} type="button" role="menuitem"
      tabIndex={-1} disabled={disabled} title={hint} aria-description={hint}
      className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-none disabled:opacity-45',
        danger ? 'text-err enabled:hover:bg-err/10 focus:bg-err/10' : 'text-txt2 enabled:hover:bg-elevated focus:bg-elevated')}
      onClick={() => { closeAndRestoreFocus(); run() }}>
      <Icon name={icon} size={14} /><span>{label}</span>
    </button>)}
  </div>, document.body)
}
