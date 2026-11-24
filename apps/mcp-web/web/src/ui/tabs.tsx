import { type ReactNode } from 'react'

import { cn } from '../lib/utils'

/**
 * 分段式选项卡（shadcn Tabs 风格）：强调条 + 选中底色，内容区域由调用方自行渲染。
 * 用原生 button + aria-selected 提供无障碍语义，测试可直接按角色定位。
 */
export function Tabs<T extends string>({ label, value, onValue, items, className }: {
  label: string
  value: T
  onValue: (value: T) => void
  items: readonly { value: T; title: ReactNode }[]
  className?: string
}) {
  return <div role="tablist" aria-label={label} className={cn('inline-flex max-w-full min-w-0 items-center gap-1 overflow-x-auto border border-line bg-elevated p-1', className)}>
    {items.map(item => <button
      key={item.value}
      type="button"
      role="tab"
      aria-selected={item.value === value}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1 text-sm font-medium transition-colors',
        item.value === value ? 'bg-surface text-txt' : 'text-txt3 hover:text-txt',
      )}
      onClick={() => onValue(item.value)}
    >{item.title}</button>)}
  </div>
}
