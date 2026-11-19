import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border border-line bg-surface text-txt hover:border-line-strong hover:bg-elevated',
        primary:
          'bg-accent text-primary-foreground shadow-glow hover:bg-accent-hover',
        secondary: 'bg-elevated text-txt2 hover:text-txt',
        outline:
          'border border-line bg-surface text-txt hover:border-line-strong hover:bg-elevated',
        ghost: 'text-txt2 hover:bg-elevated hover:text-txt',
        destructive: 'border border-err/40 bg-err/10 text-err hover:bg-err/20',
        link: 'text-accent-2 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        default: 'h-9 px-3.5 text-sm',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant, size, loading = false, disabled, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? '处理中…' : children}
      </button>
    )
  },
)
Button.displayName = 'Button'
export { buttonVariants }
