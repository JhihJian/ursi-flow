import { cn } from '@/shared/lib/utils'
import { Icon } from './icon'

export interface SpinnerProps {
  size?: number | string
  className?: string
}

/** 等待提示图标，始终对读屏隐藏，状态由宿主元素的 aria-busy 表达。 */
export function Spinner({ size = 14, className }: SpinnerProps) {
  return <Icon name="spinner" size={size} className={cn('app-spinner', className)} />
}
