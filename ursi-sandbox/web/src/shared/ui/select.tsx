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
        'max-w-full min-w-0 border border-line-strong bg-surface px-3 py-2 text-sm text-txt disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})
Select.displayName = 'Select'
