'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'

export interface ModalProps {
  open: boolean
  /** 供受控调用方感知开关变化。 */
  onOpenChange?: (open: boolean) => void
  /** 只关心关闭时使用。 */
  onClose?: () => void
  title?: React.ReactNode
  /** 面板最大宽度，数字按像素处理。 */
  width?: number | string
  placement?: 'center' | 'left'
  footer?: React.ReactNode
  children?: React.ReactNode
  /** 点击遮罩是否关闭，默认关闭。 */
  closeOnBackdrop?: boolean
  bodyOverflow?: 'auto' | 'hidden'
  hideBody?: boolean
  bodyMinHeight?: number
  closeOnEsc?: boolean
  closeLabel?: string
  closeDisabled?: boolean
  className?: string
  bodyClassName?: string
  header?: React.ReactNode
}

/** 基于 Radix Dialog 的模态框：焦点约束、顶层 Esc、关闭后焦点恢复与滚动锁由 Radix 负责。 */
export function Modal({
  open,
  onOpenChange,
  onClose,
  title,
  width = 560,
  placement = 'center',
  footer,
  children,
  closeOnBackdrop = true,
  bodyOverflow = 'auto',
  hideBody = false,
  bodyMinHeight,
  closeOnEsc = true,
  closeLabel = '关闭',
  closeDisabled = false,
  className,
  bodyClassName,
  header,
}: ModalProps) {
  const restoreFocusRef = React.useRef<HTMLElement | SVGElement | null>(null)

  function handleOpenChange(next: boolean) {
    onOpenChange?.(next)
    if (!next) onClose?.()
  }

  // 未使用 DialogTrigger 时 Radix 不会恢复焦点，这里记录打开前的焦点并在关闭时还原。
  function handleOpenAutoFocus() {
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement || active instanceof SVGElement ? active : null
  }

  function handleCloseAutoFocus(event: Event) {
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    if (!target?.isConnected || target === document.body) return
    event.preventDefault()
    target.focus({ preventScroll: true })
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <div
          className={cn(
            'fixed inset-0 z-50 flex p-4',
            placement === 'left' ? 'items-stretch justify-start' : 'items-center justify-center',
          )}
        >
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className={cn(
              'relative flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-card outline-none',
              'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
              placement === 'left' ? 'max-h-full' : 'max-h-[88dvh]',
              className,
            )}
            style={{ maxWidth: typeof width === 'number' ? `${width}px` : width }}
            onInteractOutside={(event) => { if (!closeOnBackdrop) event.preventDefault() }}
            onEscapeKeyDown={(event) => { if (!closeOnEsc) event.preventDefault() }}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
          >
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-5">
              {header ? (
                <div className="flex min-w-0 flex-1 items-center">{header}</div>
              ) : (
                <DialogPrimitive.Title asChild>
                  <div className="min-w-0 flex-1 text-[15px] font-semibold text-txt">{title}</div>
                </DialogPrimitive.Title>
              )}
              <DialogPrimitive.Close
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-txt3 enabled:hover:bg-elevated enabled:hover:text-txt disabled:opacity-40"
                disabled={closeDisabled}
                aria-label={closeLabel}
              >
                <Icon name="close" size={18} />
              </DialogPrimitive.Close>
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {hideBody ? null : (
                <div
                  className={cn(
                    'scroll-area min-h-0 flex-1 p-5',
                    bodyOverflow === 'hidden' ? 'overflow-hidden' : 'overflow-y-auto',
                    bodyClassName,
                  )}
                  style={bodyMinHeight ? { minHeight: `${bodyMinHeight}px` } : undefined}
                >
                  {children}
                </div>
              )}
              {footer ? (
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line p-4">{footer}</div>
              ) : null}
            </div>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
