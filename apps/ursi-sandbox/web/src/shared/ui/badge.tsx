import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'
const badgeVariants = cva(
  'badge inline-flex items-center gap-1.5 border px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-sbx-accent text-white',
        secondary: 'border-transparent bg-sbx-elevated text-sbx-txt',
        destructive: 'border-sbx-err/40 bg-sbx-err/10 text-sbx-err',
        outline: 'border-sbx-line text-sbx-txt',
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
