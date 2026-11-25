import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn, overlayCenteredClass, useOverlayContainer } from '../lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogPortal = DialogPrimitive.Portal

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('absolute inset-0 z-50 bg-sbx-txt/60', className)}
      {...props}
    />
  )
})
DialogOverlay.displayName = 'DialogOverlay'
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  const overlayContainer = useOverlayContainer()
  if (!overlayContainer) return null
  return (
    <DialogPortal container={overlayContainer}>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          `${overlayCenteredClass} grid w-[calc(100%-2rem)] max-w-lg gap-4 border border-sbx-accent bg-surface p-6`,
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 p-1 text-sbx-txt3 hover:bg-sbx-elevated hover:text-sbx-txt">
          <X className="size-4" />
          <span className="sr-only">关闭</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = 'DialogContent'
export const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5', className)} {...props} />
)
export const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
      className,
    )}
    {...props}
  />
)
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-serif text-lg font-semibold text-sbx-txt', className)}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-sbx-txt3', className)}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'
