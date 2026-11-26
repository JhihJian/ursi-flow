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

/**
 * Pi Web 的唯一真源：当前 pi home 与当前视图。
 *
 * 配置写 home 的注册表字段，对话与会话只读它；三个视图各自保留一份用于渲染的
 * 镜像，但选择了哪个 home 只有这里说了算。视图切换与搜索词不进实体。
 */

export type PiView = 'chat' | 'sessions' | 'config'

export interface PiHome {
  id: string
  name: string
  path: string
  description?: string
  listed: boolean
  valid: boolean
  sessionsRoot?: string
  skills?: number
  agents?: number
  mcpServers?: number
  packages?: number
  hasModels?: boolean
  hasAuth?: boolean
}

interface PiContextValue {
  homes: PiHome[]
  loading: boolean
  error: string | null
  homePath: string
  home: PiHome | null
  sessionsRoot: string
  setHomePath: (path: string) => void
  refresh: () => Promise<void>
  view: PiView
  setView: (view: PiView) => void
}

const PiContext = createContext<PiContextValue | null>(null)

const HOME_KEY = 'ursi.pi:home'
const VIEW_KEY = 'ursi.pi:view'
const VIEWS: PiView[] = ['chat', 'sessions', 'config']

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function PiProvider({ children, apiBaseUrl = '' }: { children: ReactNode; apiBaseUrl?: string }) {
  /** 接口前缀由宿主注入；生产与开发都走 `/api/pi`，服务端路由保持 `/api/*`。 */
  const base = apiBaseUrl.replace(/\/+$/, '')
  const [homes, setHomes] = useState<PiHome[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [homePath, setHomePathState] = useState(() => readLocal(HOME_KEY))
  const [view, setViewState] = useState<PiView>(() => {
    const saved = readLocal(VIEW_KEY) as PiView
    return VIEWS.includes(saved) ? saved : 'chat'
  })

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${base}/api/homes`)
      const payload = (await response.json()) as { homes?: PiHome[]; error?: { message?: string } }
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      const list = (payload.homes ?? []).map((home) => ({
        ...home,
        sessionsRoot: home.sessionsRoot ?? `${home.path}/sessions`,
      }))
      setHomes(list)
      setError(null)
      setHomePathState((current) => {
        if (current && list.some((home) => home.path === current)) return current
        const fallback = list.find((home) => home.listed && home.valid) ?? list.find((home) => home.valid)
        if (!fallback) return current
        writeLocal(HOME_KEY, fallback.path)
        return fallback.path
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setHomePath = useCallback((path: string) => {
    const next = path.trim()
    writeLocal(HOME_KEY, next)
    setHomePathState(next)
  }, [])

  const setView = useCallback((next: PiView) => {
    writeLocal(VIEW_KEY, next)
    setViewState(next)
  }, [])

  const home = useMemo(() => homes.find((item) => item.path === homePath) ?? null, [homes, homePath])
  const sessionsRoot = home?.sessionsRoot ?? (homePath ? `${homePath}/sessions` : '')

  const value = useMemo<PiContextValue>(
    () => ({
      homes,
      loading,
      error,
      homePath,
      home,
      sessionsRoot,
      setHomePath,
      refresh,
      view,
      setView,
    }),
    [homes, loading, error, homePath, home, sessionsRoot, setHomePath, refresh, view, setView],
  )

  return <PiContext.Provider value={value}>{children}</PiContext.Provider>
}

export function usePi(): PiContextValue {
  const value = useContext(PiContext)
  if (!value) throw new Error('usePi 必须在 PiProvider 内使用')
  return value
}

/** 视图首次激活才挂载：避免开工作台就扫描目录、连事件流。 */
export function useActivation(active: boolean): boolean {
  const [seen, setSeen] = useState(active)
  const seenRef = useRef(seen)
  seenRef.current = seen
  useEffect(() => {
    if (active && !seenRef.current) setSeen(true)
  }, [active])
  return seen || active
}
