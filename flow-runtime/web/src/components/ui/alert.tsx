import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const alertVariants = cva(
  'mt-3 flex flex-wrap items-start gap-3 rounded-lg px-3.5 py-3 text-sm [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-elevated text-txt2',
        error: 'bg-err/10 text-destructive',
        warning: 'bg-warn/10 text-warn',
        success: 'bg-ok/10 text-ok',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}
export function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('font-medium', className)} {...props} />
}
export function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('min-w-0 flex-1', className)} {...props} />
}
export function AlertActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('ml-auto flex items-center gap-2', className)} {...props} />
}
