import { type SVGProps } from 'react'

import { resolveIcon, type IconName } from '@/shared/icons/catalog'
import { cn } from '@/shared/lib/utils'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName | (string & {})
  size?: number | string
  /** 强制旋转；默认只有 spinner 图标旋转。 */
  busy?: boolean
  /** 置为 true 时即使是 spinner 也不旋转。 */
  disabled?: boolean
}

/** 图标只渲染本地图标目录里的可信 SVG 片段，不接受用户或接口提供的标记。 */
export function Icon({ name, size = 18, busy, disabled = false, className, ...props }: IconProps) {
  const definition = resolveIcon(name)
  const spinning = !disabled && (busy ?? name === 'spinner')
  return (
    <svg
      className={cn('app-icon', spinning && 'icon-spinner', className)}
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      width={size}
      height={size}
      viewBox={definition.viewBox}
      fill={definition.filled ? 'currentColor' : 'none'}
      stroke={definition.strokeWidth ? 'currentColor' : 'none'}
      strokeWidth={definition.strokeWidth || undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: definition.body }}
      {...props}
    />
  )
}
