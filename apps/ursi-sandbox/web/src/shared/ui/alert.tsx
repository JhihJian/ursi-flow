import * as React from 'react'
import { cn } from '../lib/utils'
export const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(
      'border border-line bg-surface p-3 text-sm',
      className,
    )}
    {...props}
  />
))
Alert.displayName = 'Alert'
