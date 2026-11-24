import { useEffect, useRef, useState } from 'react'
import { errorMessage } from './error'

/** 防止重复提交；离开页面后不再处理迟到的写入响应。 */
export function useMutation() {
  const active = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => () => active.current?.abort(), [])

  async function run<T>(send: (signal: AbortSignal) => Promise<T>, success: (result: T) => void) {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    try {
      const result = await send(controller.signal)
      if (!controller.signal.aborted) success(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    } finally {
      active.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return { busy, error, run }
}
