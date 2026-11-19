import { useEffect, useRef, useState } from 'react'

/** 只在本次派工页内复用标识。对象键无序，数组有序，材料不写入浏览器存储。 */
export function createRequestIds() {
  const ids = new Map<string, string>()
  return (parameters: unknown) => {
    const signature = JSON.stringify(parameters, (_, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : value)
    let id = ids.get(signature)
    if (!id) {
      // getRandomValues 在无 HTTPS 的内网部署也可用。
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
      ids.set(signature, id)
    }
    return id
  }
}

/** 同步锁覆盖同一帧内的连点；离开页面后，迟到的派工响应不能再触发跳转。 */
export function useDispatch() {
  const active = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => () => active.current?.abort(), [])

  async function run(send: (signal: AbortSignal) => Promise<{ id: string }>, success: (id: string) => void, fail: (error: unknown) => void) {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    try {
      const item = await send(controller.signal)
      if (!item || typeof item.id !== 'string' || !item.id.trim()) throw new Error('未收到工作项标识。')
      if (!controller.signal.aborted) success(item.id)
    } catch (error) {
      if (!controller.signal.aborted) fail(error)
    } finally {
      active.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return { busy, run }
}
