import type { ComponentProps } from 'react'
import * as Primitive from '@radix-ui/react-tabs'
import { cn } from '../lib/utils'

export const Tabs = Primitive.Root

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn(
        'inline-flex items-center gap-1 border border-sbx-line bg-sbx-elevated p-1',
        className,
      )}
      {...props}
    />
  )
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        'inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-sbx-txt3 transition-colors hover:text-sbx-txt data-[state=active]:border-sbx-accent data-[state=active]:bg-surface data-[state=active]:text-sbx-txt [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
}

export const TabsContent = Primitive.Content
