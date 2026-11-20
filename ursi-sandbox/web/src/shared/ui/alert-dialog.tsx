import type { ComponentProps } from 'react'
import * as Primitive from '@radix-ui/react-alert-dialog'
import { DialogFooter, DialogHeader } from './dialog'
import { buttonVariants } from './button'
import { cn } from '../lib/utils'

export const AlertDialog = Primitive.Root
export const AlertDialogHeader = DialogHeader
export const AlertDialogFooter = DialogFooter

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <Primitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-5 rounded-lg border border-line bg-surface p-5 shadow-lg',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}
export function AlertDialogTitle(
  props: ComponentProps<typeof Primitive.Title>,
) {
  return <Primitive.Title className="text-lg font-semibold" {...props} />
}
export function AlertDialogDescription(
  props: ComponentProps<typeof Primitive.Description>,
) {
  return (
    <Primitive.Description
      className="break-words text-sm leading-6 text-txt3"
      {...props}
    />
  )
}
export function AlertDialogCancel(
  props: ComponentProps<typeof Primitive.Cancel>,
) {
  return (
    <Primitive.Cancel
      className={buttonVariants({ variant: 'outline' })}
      {...props}
    />
  )
}
export function AlertDialogAction({
  destructive,
  ...props
}: ComponentProps<typeof Primitive.Action> & { destructive?: boolean }) {
  return (
    <Primitive.Action
      className={buttonVariants({
        variant: destructive ? 'destructive' : 'primary',
      })}
      {...props}
    />
  )
}
