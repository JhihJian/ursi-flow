import * as React from 'react'

export type ButtonVariant =
  | 'default'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'destructive'
export type ButtonSize = 'md' | 'sm' | 'icon' | 'icon-sm'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: 'btn-primary',
  outline: 'btn-outline',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  destructive: 'btn-danger',
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: React.ComponentProps<'button'> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  const cls = [
    'btn',
    VARIANT_CLASS[variant],
    size === 'sm' ? 'btn-sm' : '',
    size === 'icon' ? 'btn-icon' : '',
    size === 'icon-sm' ? 'btn-icon btn-icon-sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return <button className={cls} {...props} />
}
