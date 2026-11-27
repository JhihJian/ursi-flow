import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * 工作区当前显示什么、新对话落在哪个目录。
 *
 * 只有一种会话页面：`id` 为空是空会话页（发首条消息才建会话），非空是某条会话。
 * 路由键只用 sessionId：会话文件要等首条消息落盘才有，建完对话页面原地填 id，不换页。
 *
 * 页面不持久化：刷新回到空会话页，上次的会话就在侧栏里，点一下就回来。
 * cwd 在换 home 时由组合根清空：别的 home 下的目录对这里没有意义。
 */

export type PiPage = { kind: 'session'; id: string | null } | { kind: 'config' }

interface PiNavValue {
  page: PiPage
  /** 回到空会话页。 */
  toDraft: () => void
  toSession: (sessionId: string) => void
  toConfig: () => void
  exitConfig: () => void
  /** 新对话的工作目录：侧栏点选的目录或会话；没选就是 null，发送禁用。 */
  cwd: string | null
  setCwd: (cwd: string | null) => void
}

const PiNavContext = createContext<PiNavValue | null>(null)

export function PiNavProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PiPage>({ kind: 'session', id: null })
  const [previous, setPrevious] = useState<PiPage>({ kind: 'session', id: null })
  const [cwd, setCwd] = useState<string | null>(null)

  const toDraft = useCallback(() => setPage({ kind: 'session', id: null }), [])
  // 同一条会话重复点选不动：动了会重连事件流、清轨迹。
  const toSession = useCallback(
    (sessionId: string) =>
      setPage((current) =>
        current.kind === 'session' && current.id === sessionId ? current : { kind: 'session', id: sessionId },
      ),
    [],
  )
  const toConfig = useCallback(
    () =>
      setPage((current) => {
        if (current.kind === 'config') return current
        setPrevious(current)
        return { kind: 'config' }
      }),
    [],
  )
  const exitConfig = useCallback(() => setPage(previous), [previous])

  const value = useMemo<PiNavValue>(
    () => ({ page, toDraft, toSession, toConfig, exitConfig, cwd, setCwd }),
    [page, toDraft, toSession, toConfig, exitConfig, cwd],
  )
  return <PiNavContext.Provider value={value}>{children}</PiNavContext.Provider>
}

export function usePiNav(): PiNavValue {
  const value = useContext(PiNavContext)
  if (!value) throw new Error('usePiNav 必须在 PiNavProvider 内使用')
  return value
}
