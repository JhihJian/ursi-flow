import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/shared/api'

export interface Resource<T> {
  data: T
  loading: boolean
  error: string
  reload: () => void
}

/**
 * 加载资源并保留上次成功数据。每次加载递增版本并取消旧请求，
 * 组件卸载时同样递增版本，旧响应不会覆盖新结果也不会继续渲染。
 *
 * loader 身份变化不会触发重新加载（避免内联箭头函数导致的循环）。
 * 参数变化时可传入 resourceKey 重新加载，或显式调用 `reload()`。
 */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>, initial: T, resourceKey?: string): Resource<T> {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const loaderRef = useRef(loader)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)

  // 先同步最新的 loader，再在同一个提交内启动首次加载。
  useEffect(() => { loaderRef.current = loader })

  const reload = useCallback(async () => {
    const current = ++generation.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const result = await loaderRef.current(controller.signal)
      if (current === generation.current) setData(() => result)
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) setError(errorMessage(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])

  /** 作废所有在途请求，卸载后即使 loader 稍后完成也不能写入状态。 */
  const invalidate = useCallback(() => {
    generation.current++
    controllerRef.current?.abort()
    controllerRef.current = undefined
  }, [])

  useEffect(() => {
    // 首次加载是同步外部系统（网络或模拟后端），不调用就不会有数据。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    return invalidate
  }, [reload, invalidate, resourceKey])

  return { data, loading, error, reload }
}
