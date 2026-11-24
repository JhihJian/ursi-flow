import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
} from '@remixicon/react'

export function StatusIcon({ status }: { status?: 'running' | 'error' }) {
  if (status === 'running') {
    return <RiLoader4Line className="spin" />
  }

  if (status === 'error') {
    return <RiErrorWarningLine />
  }

  return <RiCheckboxCircleLine />
}
