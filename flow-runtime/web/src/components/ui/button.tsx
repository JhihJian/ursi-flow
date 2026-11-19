import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-border bg-card text-foreground hover:border-line-strong hover:bg-elevated',
        primary: 'border border-transparent bg-accent text-primary-foreground hover:bg-accent-hover',
        secondary: 'border border-transparent bg-secondary text-secondary-foreground hover:bg-elevated/80',
        outline: 'border border-border bg-transparent text-foreground hover:bg-elevated',
        ghost: 'border border-transparent bg-transparent text-txt2 hover:bg-elevated hover:text-foreground',
        destructive: 'border border-err/40 bg-err/10 text-destructive hover:bg-err/20',
        link: 'border-0 bg-transparent text-accent-2 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        default: 'h-9 px-3.5',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-sm': 'size-7',
        'icon-xs': 'size-6',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
})

export { buttonVariants }
