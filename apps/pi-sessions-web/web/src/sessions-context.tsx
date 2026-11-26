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
  /** 从 URL 的 ?root= 读取初始根目录；独立入口打开，嵌入工作区时关闭。 */
  readRootFromUrl?: boolean
  /** 关注/删除失败等需要用户看见的提示。缺省写进模块内的提示位。 */
  onNotice?: (notice: Notice) => void
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

  const setRoot = useCallback(
    (next: string) => {
      rememberRoot(storageKey, next)
      setSelected(null)
      setQuery('')
      setPicking(false)
      setRootState(next)
    },
    [storageKey],
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
