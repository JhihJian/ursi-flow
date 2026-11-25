import type { ComponentProps } from 'react'
import * as Primitive from '@radix-ui/react-alert-dialog'
import { DialogFooter, DialogHeader } from './dialog'
import { buttonVariants } from './button'
import { cn, appOverlayContainer, overlayCenteredClass } from '../lib/utils'

export const AlertDialog = Primitive.Root
export const AlertDialogHeader = DialogHeader
export const AlertDialogFooter = DialogFooter

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal container={appOverlayContainer()}>
      <Primitive.Overlay className="absolute inset-0 z-50 bg-txt/60" />
      <Primitive.Content
        className={cn(
          `${overlayCenteredClass} grid w-[calc(100%-2rem)] max-w-lg gap-5 border border-accent bg-surface p-5`,
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
  return <Primitive.Title className="font-serif text-lg font-semibold" {...props} />
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
