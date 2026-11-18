import * as React from 'react'

import { cn } from '@/shared/lib/utils'

/**
 * 原生下拉封装：保留 option 语义与 getByLabel 定位，
 * 已有表单下拉不替换为自定义列表控件。
 */
const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn('select', className)} {...props}>
      {children}
    </select>
  )
})

export { Select }
