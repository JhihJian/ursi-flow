import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing, ListDirFn } from './types'

export interface DirectoryListingState {
  /** 服务端规范化后的当前目录；未加载成功前为 null。 */
  listing: DirListing | null
  loading: boolean
  error: string | null
  /** 导航到任意路径（绝对路径、`~`、`~` 开头）。重复导航以最后一次为准。 */
  navigate: (path: string) => void
  /** 保留错误与路径，只重新拉取当前目录。 */
  refresh: () => void
}

/**
 * 目录列取 hook：把竞态、卸载失效与错误展示集中在一处。
 *
 * - generation 计数：并发导航只认最后一次；卸载后丢弃回包，不 setState。
 * - 不缓存：每次导航真实请求，局域网内 readdir 足够快，缓存换不来体感。
 * - 初始路径与 refresh 依赖由调用方通过 `initialPath` 与 `reloadKey` 控制，
 *   避免 hook 内部维护调用方看不见的隐式状态。
 */
export function useDirectoryListing(
  listDir: ListDirFn,
  initialPath: string,
  reloadKey: number = 0,
): DirectoryListingState {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  /** 当前锚点路径：用于 refresh；导航发出即更新，成功后由服务端路径覆盖。 */
  const currentPath = useRef(initialPath)

  const load = useCallback(
    (target: string) => {
      const gen = ++generation.current
      currentPath.current = target
      setLoading(true)
      setError(null)
      listDir(target)
        .then((next) => {
          if (gen !== generation.current) return
          setListing(next)
          setLoading(false)
        })
        .catch((failure: unknown) => {
          if (gen !== generation.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
          setLoading(false)
        })
    },
    [listDir],
  )

  const navigate = useCallback(
    (target: string) => {
      load(target)
    },
    [load],
  )

  const refresh = useCallback(() => {
    load(currentPath.current)
  }, [load])

  // 卸载（或 listDir 变化）时失效在途请求，慢回包不落到已卸载组件上。
  useEffect(() => {
    const gen = ++generation.current
    currentPath.current = initialPath
    setLoading(true)
    setError(null)
    listDir(initialPath)
      .then((next) => {
        if (gen !== generation.current) return
        setListing(next)
        setLoading(false)
      })
      .catch((failure: unknown) => {
        if (gen !== generation.current) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [listDir, initialPath, reloadKey])

  return { listing, loading, error, navigate, refresh }
}
