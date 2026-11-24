import type { ComponentProps } from 'react'
import * as Primitive from '@radix-ui/react-switch'
import { cn } from '../lib/utils'

export function Switch({
  className,
  ...props
}: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line-strong bg-line-strong transition-colors disabled:opacity-50 data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-5 rounded-full bg-surface shadow-sm transition-transform data-[state=checked]:translate-x-5" />
    </Primitive.Root>
  )
}
