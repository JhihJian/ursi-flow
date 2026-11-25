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
        'inline-flex h-6 w-11 shrink-0 items-center border border-sbx-line-strong bg-sbx-line-strong transition-colors disabled:opacity-50 data-[state=checked]:border-sbx-accent data-[state=checked]:bg-sbx-accent',
        className,
      )}
      {...props}
    >
      <Primitive.Thumb className="pointer-events-none block size-5 border border-sbx-line-strong bg-surface transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:border-sbx-accent" />
    </Primitive.Root>
  )
}
