import * as React from 'react'

import { cn } from '../lib/utils'

/** 文本输入：默认套用现有 `.input` 组件类，便于直接替换旧表单项。 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(function Input(
  { className, type, ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn('input', className)} {...props} />
})

export { Input }
