import * as React from 'react'

import { cn } from '@/shared/lib/utils'

/** 多行文本：默认套用现有 `.textarea` 组件类。 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn('textarea', className)} {...props} />
})

export { Textarea }
