import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/** 原生 select，视觉与 Input 一致；节点选择这类短列表不需要弹层组件。 */
export const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <span className="relative flex min-w-0">
        <select
          ref={ref}
          className={cn(
            'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-card py-1 pl-3 pr-8 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </span>
    )
  },
)
