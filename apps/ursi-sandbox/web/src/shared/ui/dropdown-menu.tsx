import type { ComponentProps } from 'react'
import * as Primitive from '@radix-ui/react-dropdown-menu'
import { cn, useOverlayContainer } from '../lib/utils'

export const DropdownMenu = Primitive.Root
export const DropdownMenuTrigger = Primitive.Trigger

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  const overlayContainer = useOverlayContainer()
  if (!overlayContainer) return null
  return (
    <Primitive.Portal container={overlayContainer}>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 border border-sbx-accent bg-surface p-1 text-sbx-txt',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 px-2 py-2 text-xs outline-none focus:bg-sbx-accent-dim data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuSeparator(
  props: ComponentProps<typeof Primitive.Separator>,
) {
  return <Primitive.Separator className="-mx-1 my-1 h-px bg-sbx-line" {...props} />
}
