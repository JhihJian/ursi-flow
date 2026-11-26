import { useCallback, useEffect, useRef, useState } from 'react'
import type { Listing, SessionsApi } from '../api'

/** 明细还在后台读时最多自动再拉这么多轮，避免文件一直在写的会话把轮询挂住。 */
const MAX_FOLLOW_UPS = 60
const FOLLOW_UP_DELAY_MS = 800

/**
 * 一个根目录下的会话列表。服务端先给头部元信息，消息数与首条用户消息由后台补齐，
 * 因此响应里的 `pendingDetails` 大于 0 时隔一会自动再拉一次，补齐后自然停下。
 */
export function useSessions(root: string | null, api: SessionsApi) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const followUps = useRef(0)

  const load = useCallback(
    async (target: string) => {
      const current = ++generation.current
      setLoading(true)
      try {
        const next = await api.fetchSessions(target)
        if (current !== generation.current) return
        setListing(next)
        setError(null)
        return next
      } catch (failure) {
        if (current !== generation.current) return
        setListing(null)
        setError(failure instanceof Error ? failure.message : String(failure))
        return null
      } finally {
        if (current === generation.current) setLoading(false)
      }
    },
    [api],
  )

  useEffect(() => {
    followUps.current = 0
    setListing(null)
    setError(null)
    if (root) void load(root)
  }, [root, load])

  useEffect(() => {
    if (!root || !listing || listing.pendingDetails === 0) return
    if (followUps.current >= MAX_FOLLOW_UPS) return
    const timer = setTimeout(() => {
      followUps.current += 1
      void load(root)
    }, FOLLOW_UP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [root, listing, load])

  /**
   * 定时轻扫：会话可能在别的进程里继续增长，列表要能跟上活动时间。
   * 服务端按 size + mtimeMs 命中缓存，这里接近一次目录 stat；页面隐藏时跳过。
   */
  useEffect(() => {
    if (!root) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(root)
    }, 15_000)
    return () => clearInterval(timer)
  }, [root, load])

  const reload = useCallback(() => {
    if (!root) return
    followUps.current = 0
    void load(root)
  }, [root, load])

  /** 供命令使用：切换根目录后按 id 定位会话需要等列表回来。 */
  const loadNow = useCallback(
    async (target: string) => {
      followUps.current = 0
      return await load(target)
    },
    [load],
  )

  return { listing, loading, error, reload, loadNow }
}
