import {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiForbidLine,
  RiPlayCircleLine,
} from '@remixicon/react'
import type { TaskStatus } from '@/api/types'

/** 状态图标统一取自 Remix Icon 的圆形系列，保证五个符号视觉大小一致。 */
const statusIcons: Record<TaskStatus, typeof RiCheckboxBlankCircleLine> = {
  pending: RiCheckboxBlankCircleLine,
  in_progress: RiPlayCircleLine,
  blocked: RiForbidLine,
  done: RiCheckboxCircleLine,
  cancelled: RiCloseCircleLine,
}

export function StatusIcon({ status, size = 12 }: { status: TaskStatus; size?: number }) {
  const Icon = statusIcons[status]
  return <Icon size={size} className="status-symbol" aria-hidden="true" />
}
