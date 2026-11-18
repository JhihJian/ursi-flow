import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'
import type { IconName } from '@/shared/icons/catalog'
import { Icon } from './icon'
import { Spinner } from './spinner'

/**
 * 共享按钮：shadcn Button 的结构与旧 AppButton 的外观、别名合并。
 * `default` 沿用旧默认的描边外观，`primary` 才是品牌紫主按钮。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-base',
  {
    variants: {
      variant: {
        default: 'border border-line bg-surface text-txt hover:border-line-strong hover:bg-elevated',
        primary: 'bg-accent text-white shadow-glow hover:bg-accent-hover',
        secondary: 'bg-elevated text-txt2 hover:text-txt',
        subtle: 'bg-elevated text-txt2 hover:text-txt',
        outline: 'border border-line bg-surface text-txt hover:border-line-strong hover:bg-elevated',
        ghost: 'text-txt2 hover:text-txt',
        destructive: 'border border-err/40 bg-err/10 text-err hover:bg-err/20',
        danger: 'border border-err/40 bg-err/10 text-err hover:bg-err/20',
        link: 'text-accent-2 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-6 px-2.5 text-xs',
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
  asChild?: boolean
  /** 前置图标名，取值来自本地图标目录。 */
  icon?: IconName | (string & {})
  /** 等待中：显示加载图标、置 aria-busy 并禁用。 */
  loading?: boolean
  /** 占满可用宽度。 */
  block?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, icon, loading = false, block = false, type, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  const busy = Boolean(loading)
  const iconSize = size === 'sm' ? 14 : 16

  if (asChild) {
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }), block && 'w-full', !disabled && 'ui-pressable')} {...props}>
        {children}
      </Comp>
    )
  }

  return (
    <Comp
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size, className }), block && 'w-full', !disabled && !busy && 'ui-pressable')}
      disabled={disabled || busy}
      aria-busy={busy ? 'true' : undefined}
      {...props}
    >
      {busy ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children === undefined || children === null ? null : (
        <span className="relative z-[1] inline-flex items-center gap-1.5">{children}</span>
      )}
    </Comp>
  )
})
Button.displayName = 'Button'

export { Button }
