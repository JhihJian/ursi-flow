import { useCallback, useEffect, useRef, useState } from 'react'
import type { Listing, SessionsApi } from '../api'

/** 明细还在后台读时最多自动再拉这么多轮，避免文件一直在写的会话把轮询挂住。 */
const MAX_FOLLOW_UPS = 60
const FOLLOW_UP_DELAY_MS = 800
const FOLLOW_UP_MAX_DELAY_MS = 5000
const POLL_INTERVAL_MS = 15_000

interface LoadOptions {
  /** 后台刷新：沿用上一份列表与版本号，失败不把界面清空。 */
  background?: boolean
}

/**
 * 一个根目录下的会话列表。
 *
 * 服务端先给头部元信息，消息数与首条用户消息由后台补齐，因此响应里的
 * `pendingDetails` 大于 0 时隔一会自动再拉一次，补齐后自然停下。
 *
 * 定时刷新与补明细都带上一次的版本号：集合没变时服务端只回一个 `notModified`，
 * 一千多条会话的目录每次只传几十个字节，而不是整份 1MB 多的 JSON。
 */
export function useSessions(root: string | null, api: SessionsApi) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const followUps = useRef(0)
  const revision = useRef<number | undefined>(undefined)

  const load = useCallback(
    async (target: string, { background = false }: LoadOptions = {}) => {
      const current = ++generation.current
      if (!background) setLoading(true)
      try {
        const next = await api.fetchSessions(target, background ? revision.current : undefined)
        if (current !== generation.current) return
        setError(null)
        // 没变就什么都不做：列表引用不动，下游的分组与筛选都不会重算。
        if (next) {
          revision.current = next.revision
          setListing(next)
        }
      } catch (failure) {
        if (current !== generation.current) return
        if (background) return
        setListing(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (current === generation.current && !background) setLoading(false)
      }
    },
    [api],
  )

  // 换根目录：清掉上一份列表与版本号，整份重拉。
  useEffect(() => {
    followUps.current = 0
    revision.current = undefined
    setListing(null)
    setError(null)
    if (root) void load(root)
  }, [root, load])

  // 补明细：服务端每补一批版本号就变，这里隔一会再拉；一轮一轮往后退，
  // 上千个文件首次补齐时不会每 800ms 就重拉一次整份。
  useEffect(() => {
    if (!root || !listing || listing.pendingDetails === 0) return
    if (followUps.current >= MAX_FOLLOW_UPS) return
    const delay = Math.min(FOLLOW_UP_DELAY_MS * 2 ** followUps.current, FOLLOW_UP_MAX_DELAY_MS)
    const timer = setTimeout(() => {
      followUps.current += 1
      void load(root, { background: true })
    }, delay)
    return () => clearTimeout(timer)
  }, [root, listing, load])

  /**
   * 定时轻扫：会话可能在别的进程里继续增长，列表要能跟上活动时间。
   * 页面隐藏时跳过；后台刷新不置 loading，免得刷新按钮每 15 秒闪一次禁用态。
   */
  useEffect(() => {
    if (!root) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(root, { background: true })
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [root, load])

  const reload = useCallback(() => {
    if (!root) return
    followUps.current = 0
    void load(root)
  }, [root, load])

  return { listing, loading, error, reload }
}
