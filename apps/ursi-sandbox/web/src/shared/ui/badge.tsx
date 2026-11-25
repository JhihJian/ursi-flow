import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'
const badgeVariants = cva(
  'badge inline-flex items-center gap-1.5 border px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-white',
        secondary: 'border-transparent bg-elevated text-txt',
        destructive: 'border-err/40 bg-err/10 text-err',
        outline: 'border-line text-txt',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)
export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}
export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}
