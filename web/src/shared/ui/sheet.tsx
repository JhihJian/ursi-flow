'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close
const SheetPortal = DialogPrimitive.Portal

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-0 border-line bg-surface shadow-card outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom: 'inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right: 'inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
      },
    },
    defaultVariants: { side: 'right' },
  },
)

export interface SheetContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'>,
    VariantProps<typeof sheetVariants> {
  /** 抽屉标题，同时作为对话框无障碍名称。 */
  title?: React.ReactNode
  closeLabel?: string
  showClose?: boolean
  footer?: React.ReactNode
}

/** 左侧导航等场景使用的抽屉，行为与 Modal 一致，仅外壳不同。 */
const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  function SheetContent(
    { side = 'left', className, children, title, closeLabel = '关闭', showClose = true, footer, ...props },
    ref,
  ) {
    const restoreFocusRef = React.useRef<HTMLElement | null>(null)

    function handleOpenAutoFocus() {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }

    function handleCloseAutoFocus(event: Event) {
      const target = restoreFocusRef.current
      restoreFocusRef.current = null
      if (!target?.isConnected || target === document.body) return
      event.preventDefault()
      target.focus({ preventScroll: true })
    }

    return (
      <SheetPortal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={ref}
          aria-describedby={undefined}
          className={cn(sheetVariants({ side }), className)}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
          {...props}
        >
          {title === undefined ? null : (
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
              <DialogPrimitive.Title asChild>
                <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-txt">{title}</div>
              </DialogPrimitive.Title>
              {showClose ? (
                <DialogPrimitive.Close
                  type="button"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-txt3 hover:bg-elevated hover:text-txt"
                  aria-label={closeLabel}
                >
                  <Icon name="close" size={18} />
                </DialogPrimitive.Close>
              ) : null}
            </div>
          )}
          <div className="scroll-area min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? <div className="shrink-0 border-t border-line p-4">{footer}</div> : null}
        </DialogPrimitive.Content>
      </SheetPortal>
    )
  },
)

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-2 p-4 text-left', className)} {...props} />
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse p-4 sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
}

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold text-txt', className)} {...props} />
})

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('text-sm text-txt3', className)} {...props} />
})

export {
  Sheet,
  SheetPortal,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
