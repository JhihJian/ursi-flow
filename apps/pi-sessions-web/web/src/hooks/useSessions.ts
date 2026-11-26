import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSessions, type Listing } from '@/api'

/** 明细还在后台读时最多自动再拉这么多轮，避免文件一直在写的会话把轮询挂住。 */
const MAX_FOLLOW_UPS = 60
const FOLLOW_UP_DELAY_MS = 800

/**
 * 一个根目录下的会话列表。服务端先给头部元信息，消息数与首条用户消息由后台补齐，
 * 因此响应里的 `pendingDetails` 大于 0 时隔一会自动再拉一次，补齐后自然停下。
 */
export function useSessions(root: string | null) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const followUps = useRef(0)

  const load = useCallback(async (target: string) => {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await fetchSessions(target)
      if (current !== generation.current) return
      setListing(next)
      setError(null)
    } catch (failure) {
      if (current !== generation.current) return
      setListing(null)
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])

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

  const reload = useCallback(() => {
    if (!root) return
    followUps.current = 0
    void load(root)
  }, [root, load])

  return { listing, loading, error, reload }
}
