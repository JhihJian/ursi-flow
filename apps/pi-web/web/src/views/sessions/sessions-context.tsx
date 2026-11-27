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
  type Prefs,
  type ServerConfig,
  type SessionsApi,
  type SessionRow,
} from './api'
import { useSessions } from './hooks/useSessions'
import { indexLiveByFile, type LiveSessionFeed, type LiveSessionInfo, type LiveSessionSource } from './live'
import { todayKey, dayKey } from './lib/format'

/**
 * 模块共享状态：根目录、搜索词、当前选中会话、关注的项目与服务配置。
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
  /** 初始根目录：传了就优先于本地记忆，用于外部指定某个会话集合。 */
  initialRoot?: string
  /** 宿主指定的根目录（合并后由当前 pi home 派生），变化后跟随。 */
  root?: string
  /** 用户切根目录时通知宿主，保证同一份真源。 */
  onRootChange?: (root: string) => void
  /** 从 URL 的 ?root= 读取初始根目录；独立入口打开，嵌入工作区时关闭。 */
  readRootFromUrl?: boolean
  /** 关注/删除失败等需要用户看见的提示。缺省写进模块内的提示位。 */
  onNotice?: (notice: Notice) => void
  /**
   * 会话运行态来源，由宿主注入（会话模块不采集心跳）。
   * 不注入时模块按纯磁盘列表工作，行为与之前完全一致。
   */
  liveSessions?: LiveSessionSource
  /** 在对话视图继续这条会话；不注入时不显示该入口。 */
  resumeSessionInChat?: (input: { sessionFile: string }) => Promise<unknown>
}

export interface SessionsController {
  api: SessionsApi
  root: string | null
  setRoot: (root: string) => void
  config: ServerConfig | null
  configError: string | null
  query: string
  setQuery: (query: string) => void
  selected: SessionRow | null
  select: (row: SessionRow | null) => void
  /** 选目录面板是否打开：面板渲染在工作区区域，那里有足够宽度放路径与目录树。 */
  picking: boolean
  setPicking: (picking: boolean) => void
  /**
   * 按日筛选选中的日历日（`YYYY-MM-DD`），空集表示不筛。默认只看今天。
   * 放在共享状态里：跨模块跳转要往里加日期，换根目录要重置，侧栏折叠不能丢。
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
  /** 运行态（未注入来源时为空）。 */
  live: LiveSessionInfo[]
  liveByPath: Map<string, LiveSessionInfo[]>
  liveError: string | null
  /** 心跳插件已检测到：运行态功能（绿点、运行中列表）总开关。 */
  liveEnabled: boolean
  /** 打开某条会话（可按会话文件或 id 定位），会切根目录并放开日期筛选。 */
  openSession: (input: { root?: string; id?: string; sessionFile?: string }) => void
  /** 存活会话（心跳在跳，含运行中与空闲）所在的会话文件路径。 */
  alivePaths: ReadonlySet<string>
  /** 选中会话能否交给对话继续（宿主是否注入了 resumeSessionInChat）。 */
  canResumeInChat: boolean
  resumeInChat: () => Promise<void>
}

/** 记住的根目录只在本模块的键下，宿主注入 storageKey 后互不干扰。 */
function rememberedRoot(storageKey: string, readFromUrl: boolean): string | null {
  if (readFromUrl && typeof window !== 'undefined') {
    const fromUrl = new URLSearchParams(window.location.search).get('root')
    if (fromUrl) return fromUrl
  }
  try {
    return window.localStorage.getItem(`${storageKey}:root`)
  } catch {
    return null
  }
}

function rememberRoot(storageKey: string, root: string): void {
  try {
    window.localStorage.setItem(`${storageKey}:root`, root)
  } catch {
    /* 隐私模式下写不进去，按不记忆处理 */
  }
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
  const storageKey = options.storageKey ?? 'pi-sessions'
  const readRootFromUrl = options.readRootFromUrl ?? false

  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [root, setRootState] = useState<string | null>(
    () => options.initialRoot ?? rememberedRoot(storageKey, readRootFromUrl),
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SessionRow | null>(null)
  const [picking, setPicking] = useState(false)
  const [pinnedProjects, setPinnedProjects] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [selectedDays, setSelectedDaysState] = useState<ReadonlySet<string>>(() => new Set([todayKey()]))
  const [live, setLive] = useState<LiveSessionInfo[]>([])
  const [liveError, setLiveError] = useState<string | null>(null)
  /** 心跳插件是否检测到：未检测到时运行态功能整体关闭（不显示绿点）。 */
  const [liveEnabled, setLiveEnabled] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<{
    id?: string
    sessionFile?: string
  } | null>(null)

  const notify = useCallback(
    (next: Notice) => {
      if (options.onNotice) options.onNotice(next)
      else setNotice(next)
    },
    [options.onNotice],
  )

  useEffect(() => {
    void api
      .fetchConfig()
      .then(setConfig)
      .catch((failure: unknown) => setConfigError(errorText(failure)))
    void api
      .fetchPrefs()
      .then((prefs: Prefs) => setPinnedProjects(prefs.pinnedProjects))
      .catch(() => setPinnedProjects([]))
  }, [api])

  // 没有记住过根就用服务端默认值；只补一次，不覆盖用户的选择。
  useEffect(() => {
    if (root || !config) return
    const fallback = options.initialRoot ?? config.defaultRoot
    setRootState(fallback)
    rememberRoot(storageKey, fallback)
  }, [root, config, storageKey, options.initialRoot])

  const { listing, loading, error, reload } = useSessions(root, api)

  // 运行态：来源由宿主注入，5 秒一次；心跳插件未检测到时整段不跑（功能门控），
  // 安装插件后下个轮询周期自动开启。失败只降级成一行小字，不影响磁盘列表。
  const liveSource = options.liveSessions
  useEffect(() => {
    if (!liveSource) return
    let alive = true
    const load = () => {
      void liveSource
        .fetch()
        .then((feed: LiveSessionFeed) => {
          if (!alive) return
          setLive(feed.heartbeatDetected ? feed.sessions : [])
          setLiveEnabled(feed.heartbeatDetected)
          setLiveError(null)
        })
        .catch((failure: unknown) => {
          if (alive) setLiveError(errorText(failure))
        })
    }
    load()
    const timer = setInterval(load, 5_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [liveSource])

  const liveByPath = useMemo(
    () => indexLiveByFile({ sessions: live, stale: 0, warnings: [], heartbeatDetected: liveEnabled, now: Date.now() }),
    [live, liveEnabled],
  )
  // 存活的会话豁免日期筛选：空闲挂着的会话不写盘，活动时间停在开它那天，
  // 按「今天」筛会让昨晚开着今天还活着的会话从列表里消失。
  const setSelectedDays = useCallback(
    (update: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => {
      setSelectedDaysState((current) =>
        typeof update === 'function' ? update(current) : update,
      )
    },
    [],
  )

  const alivePaths = useMemo(() => new Set(liveByPath.keys()), [liveByPath])

  // 命令跳转：等列表到达后按会话文件优先、id 兜底选中，并把它的日期并入筛选，
  // 否则选中了却在列表里看不见。
  useEffect(() => {
    if (!pendingSelection || !listing) return
    const wanted = pendingSelection.sessionFile
    const row = wanted
      ? listing.sessions.find((item) => item.path === wanted)
      : listing.sessions.find((item) => item.id === pendingSelection.id)
    if (!row) {
      if (!loading && listing.pendingDetails === 0) {
        notify({ kind: 'error', message: `这个根目录里找不到该会话：${wanted ?? pendingSelection.id}` })
        setPendingSelection(null)
      }
      return
    }
    setSelected(row)
    setSelectedDays((current) => new Set([...current, dayKey(row.modified)]))
    setPendingSelection(null)
  }, [listing, loading, pendingSelection, notify])

  const notifyRootChange = options.onRootChange
  const setRoot = useCallback(
    (next: string) => {
      notifyRootChange?.(next)
      rememberRoot(storageKey, next)
      setSelected(null)
      setQuery('')
      setPicking(false)
      // 换根目录回到只看今天：别的目录里选的日期对这里没有意义。
      setSelectedDays(new Set([todayKey()]))
      setRootState(next)
    },
    [storageKey, notifyRootChange],
  )

  // 宿主给的根是唯一真源：home 一变就跟随（外部目录仍可手动改成任意路径）。
  const externalRoot = options.root
  useEffect(() => {
    if (!externalRoot || externalRoot === root) return
    setRootState(externalRoot)
  }, [externalRoot, root])

  /** 跨模块命令用：切根目录 + 等列表到达后选中目标会话。 */
  const openSession = useCallback(
    (input: { root?: string; id?: string; sessionFile?: string }) => {
      const target = input.root?.trim()
      if (target && target !== root) setRoot(target)
      setSelected(null)
      setPendingSelection({ id: input.id, sessionFile: input.sessionFile })
      setPicking(false)
    },
    [root, setRoot],
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
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const deleteSession = useCallback(
    (row: SessionRow) => {
      if (!root) return
      void api
        .deleteSession(root, row.id)
        .then(() => {
          if (selectedRef.current?.id === row.id) setSelected(null)
          reload()
        })
        .catch((failure: unknown) =>
          notify({ kind: 'error', message: `删除失败：${errorText(failure)}` }),
        )
    },
    [api, root, reload, notify],
  )

  const resumeSessionInChat = options.resumeSessionInChat
  const resumeInChat = useCallback(async () => {
    const row = selectedRef.current
    if (!row) throw new Error('先在左侧选一条会话')
    if (!resumeSessionInChat) throw new Error('对话视图未挂载')
    await resumeSessionInChat({ sessionFile: row.path })
  }, [resumeSessionInChat])

  const value: SessionsController = {
    api,
    root,
    setRoot,
    config,
    configError,
    query,
    setQuery,
    selected,
    select: setSelected,
    picking,
    setPicking,
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
    live,
    liveByPath,
    liveError,
    liveEnabled,
    openSession,
    alivePaths,
    canResumeInChat: Boolean(resumeSessionInChat),
    resumeInChat,
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
