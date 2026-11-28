import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  createSessionsApi,
  NO_ROWS,
  type Prefs,
  type SessionsApi,
  type SessionRow,
  type SessionRuntime,
} from './api'
import { useSessions } from './hooks/useSessions'
import { indexRuntimesByFile } from './live'
import { todayKey } from './lib/format'

/**
 * 模块共享状态：根目录、搜索词与关注的项目。当前页面在 PiNav，不在这里。
 *
 * 侧边栏与工作区在 DOM 上是两块（外壳用 portal 保留上下文），因此这里只放纯状态，
 * 不渲染任何 DOM；样式作用域由 Sidebar / Workspace 各自的根类负责。
 */

export type NoticeKind = 'info' | 'error'

export interface Notice {
  kind: NoticeKind
  message: string
}

export interface SessionsControllerOptions {
  /** 接口前缀，由宿主注入；独立入口传 '/api'。 */
  apiBaseUrl?: string
  /** localStorage 键前缀，避免同一浏览器里两个实例互相覆盖。 */
  storageKey?: string
  /** 会话根目录：就是当前 home 的 `<home>/sessions`，由组合根注入，界面不再切换。 */
  initialRoot?: string
  /** 关注/删除失败等需要用户看见的提示。缺省写进模块内的提示位。 */
  onNotice?: (notice: Notice) => void
  /** 某条会话被删除后通知宿主：页面正指着它时要退回别处。 */
  onDeleted?: (sessionId: string) => void
}

export interface SessionsController {
  api: SessionsApi
  root: string | null
  query: string
  setQuery: (query: string) => void
  /**
   * 按日筛选选中的日历日（`YYYY-MM-DD`），空集表示不筛。默认只看今天：
   * 累积几天后首屏只剩最近的活动，完整历史交给搜索与「全部」。
   * 放在共享状态里：跨模块跳转要往里加日期，换 home 要重置，侧栏折叠不能丢。
   */
  selectedDays: ReadonlySet<string>
  setSelectedDays: (days: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void
  pinnedProjects: string[]
  togglePin: (projectKey: string, pinned: boolean) => void
  deleteSession: (row: SessionRow) => void
  notice: Notice | null
  clearNotice: () => void
  notify: (notice: Notice) => void
  /** 列表数据（含补明细轮询）。 */
  listing: ReturnType<typeof useSessions>['listing']
  loading: boolean
  error: string | null
  reload: () => void
  /** 运行态按会话文件路径索引，随清单一起到达。 */
  runtimeByPath: Map<string, SessionRuntime[]>
  /** 心跳插件已检测到：没装时不会有其它进程的运行态，侧栏提示去装。 */
  heartbeatDetected: boolean
}

/**
 * 状态集中在一个 Provider 里实现（不用 zustand）：跨区域共享的只有这几个值，
 * 而且 Sidebar 与 Workspace 必须看到同一份，用 Context 最直接。
 */
export function SessionsProvider({
  options,
  children,
}: {
  options: SessionsControllerOptions
  children: ReactNode
}) {
  const api = useMemo(() => createSessionsApi(options.apiBaseUrl ?? '/api'), [options.apiBaseUrl])

  // 根目录就是组合根给的 `<home>/sessions`：它随 home 变化自动重算，界面上没有第二处来源。
  const root = options.initialRoot ?? null
  const [query, setQuery] = useState('')
  const [pinnedProjects, setPinnedProjects] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [selectedDays, setSelectedDaysState] = useState<ReadonlySet<string>>(() => new Set([todayKey()]))

  // 换 home（即换根）时重置搜索与日期筛选：旧根里选的日期与搜索词对新根没有意义。
  const lastRoot = useRef(root)
  useEffect(() => {
    if (lastRoot.current === root) return
    lastRoot.current = root
    setQuery('')
    setSelectedDaysState(new Set([todayKey()]))
  }, [root])

  const notify = useCallback(
    (next: Notice) => {
      if (options.onNotice) options.onNotice(next)
      else setNotice(next)
    },
    [options.onNotice],
  )

  useEffect(() => {
    void api
      .fetchPrefs()
      .then((prefs: Prefs) => setPinnedProjects(prefs.pinnedProjects))
      .catch(() => setPinnedProjects([]))
  }, [api])

  const { listing, loading, error, reload } = useSessions(root, api)

  // 运行态就在清单的每条实体上：本进程装配的与其它进程心跳合流后由服务端挂好，
  // 心跳有变化集合版本号就变，15 秒轮询自然跟上。不另拉接口，避免两份数据对不齐。
  const runtimeByPath = useMemo(() => indexRuntimesByFile(listing?.sessions ?? NO_ROWS), [listing])
  const setSelectedDays = useCallback(
    (update: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => {
      setSelectedDaysState((current) =>
        typeof update === 'function' ? update(current) : update,
      )
    },
    [],
  )

  /**
   * 关注/取消关注：先在本地生效，再落盘。失败时回滚并说明原因，
   * 避免界面显示成功而磁盘没有变化。
   */
  const pinnedRef = useRef(pinnedProjects)
  pinnedRef.current = pinnedProjects
  const togglePin = useCallback(
    (projectKey: string, pinned: boolean) => {
      const previous = pinnedRef.current
      const next = pinned
        ? [projectKey, ...previous.filter((key) => key !== projectKey)]
        : previous.filter((key) => key !== projectKey)
      setPinnedProjects(next)
      void api
        .updatePrefs(pinned ? { pin: projectKey } : { unpin: projectKey })
        .then((prefs) => setPinnedProjects(prefs.pinnedProjects))
        .catch((failure: unknown) => {
          setPinnedProjects(previous)
          notify({ kind: 'error', message: `无法保存关注设置：${errorText(failure)}` })
        })
    },
    [api, notify],
  )

  /** 删除会话文件：成功后从列表移除，失败时说明原因且不动列表。 */
  const deleteSession = useCallback(
    (row: SessionRow) => {
      if (!root) return
      void api
        .deleteSession(root, row.id)
        .then(() => {
          options.onDeleted?.(row.id)
          reload()
        })
        .catch((failure: unknown) =>
          notify({ kind: 'error', message: `删除失败：${errorText(failure)}` }),
        )
    },
    [api, root, reload, notify, options.onDeleted],
  )

  const value: SessionsController = {
    api,
    root,
    query,
    setQuery,
    selectedDays,
    setSelectedDays,
    pinnedProjects,
    togglePin,
    deleteSession,
    notice,
    clearNotice: () => setNotice(null),
    notify,
    listing,
    loading,
    error,
    reload,
    runtimeByPath,
    heartbeatDetected: listing?.heartbeatDetected ?? false,
  }

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

const SessionsContext = createContext<SessionsController | null>(null)

export function useSessionsController(): SessionsController {
  const value = useContext(SessionsContext)
  if (!value) throw new Error('useSessionsController 必须在 SessionsProvider 内使用')
  return value
}

export function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
