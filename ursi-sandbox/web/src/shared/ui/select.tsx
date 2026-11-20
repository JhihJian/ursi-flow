import * as React from 'react'
import { cn } from '../lib/utils'
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<'select'>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'max-w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-txt focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})
Select.displayName = 'Select'
