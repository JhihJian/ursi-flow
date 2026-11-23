import type { MouseEvent as ReactMouseEvent } from 'react'

export type MenuAnchor = { x: number; y: number; trigger: HTMLElement | SVGElement | null }

export function menuAnchor(event: MouseEvent | ReactMouseEvent, fallback: HTMLElement | null): MenuAnchor {
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget
  const active = document.activeElement
  const element = target instanceof HTMLElement || target instanceof SVGElement ? target : null
  const trigger = active instanceof HTMLElement && element?.contains(active) ? active
    : element?.hasAttribute('tabindex') ? element : fallback
  if (event.button === 2 || !trigger) return { x: event.clientX, y: event.clientY, trigger }
  const { left, bottom } = trigger.getBoundingClientRect()
  return { x: left, y: bottom, trigger }
}
