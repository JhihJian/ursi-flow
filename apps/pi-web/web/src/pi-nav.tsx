import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * 工作区当前显示什么、新对话落在哪个目录。
 *
 * 页面不持久化：刷新回到新对话页，上次的会话就在侧栏里，点一下就回来。
 * cwd 在换 home 时由组合根清空：别的 home 下的目录对这里没有意义。
 */

export type PiPage =
  | { kind: 'draft' }
  | { kind: 'session'; sessionFile: string }
  | { kind: 'config' }

interface PiNavValue {
  page: PiPage
  /** 进配置前所在的页面，退出配置时回到它。 */
  toDraft: () => void
  toSession: (sessionFile: string) => void
  toConfig: () => void
  exitConfig: () => void
  /** 新对话的工作目录：侧栏点选的目录或会话；没选就是 null，发送禁用。 */
  cwd: string | null
  setCwd: (cwd: string | null) => void
}

const PiNavContext = createContext<PiNavValue | null>(null)

export function PiNavProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PiPage>({ kind: 'draft' })
  const [previous, setPrevious] = useState<PiPage>({ kind: 'draft' })
  const [cwd, setCwd] = useState<string | null>(null)

  const toDraft = useCallback(() => setPage({ kind: 'draft' }), [])
  // 同一条会话重复点选不动：动了会重连事件流、清轨迹。
  const toSession = useCallback(
    (sessionFile: string) =>
      setPage((current) =>
        current.kind === 'session' && current.sessionFile === sessionFile
          ? current
          : { kind: 'session', sessionFile },
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
