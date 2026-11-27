import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { useAppStore } from './pi-store'

/**
 * Pi Web 的 home 真源：当前选了哪个 pi home。
 *
 * 清单与增删改在 pi-store，这里只负责「选了哪个」以及由此派生的 sessions 根。
 * 对话、会话、配置三处都从这里读 home，不再各自拉 /api/homes。
 */

export interface PiHome {
  id: string
  name: string
  path: string
  description?: string
  listed: boolean
  valid: boolean
  error?: string
  sessionsRoot: string
}

interface PiContextValue {
  homes: PiHome[]
  loading: boolean
  error: string | null
  homePath: string
  home: PiHome | null
  sessionsRoot: string
  setHomePath: (path: string) => void
  /** 切换 home：校验路径并记住，失败时留在原处。 */
  switchHome: (path: string) => Promise<boolean>
  refresh: () => Promise<void>
}

const PiContext = createContext<PiContextValue | null>(null)

export function PiProvider({
  children,
  apiBaseUrl = '',
  onApiBase,
}: {
  children: ReactNode
  apiBaseUrl?: string
  /** 接口前缀交给 API 层；由组合根注入，PiProvider 不关心它怎么存。 */
  onApiBase?: (base: string) => void
}) {
  const base = apiBaseUrl.replace(/\/+$/, '')
  useEffect(() => {
    onApiBase?.(base)
  }, [base, onApiBase])

  const {
    homes: summaries,
    homesLoading,
    homePath,
    homeError,
    homeValid,
    initHome,
    confirmHome,
    refreshHomes,
  } = useAppStore()

  // 首次挂载拉清单并校验当前 home；之后由 store 内部跟随。
  const started = useMemo(() => ({ done: false }), [])
  useEffect(() => {
    if (started.done) return
    started.done = true
    void initHome()
  }, [initHome, started])

  const homes = useMemo<PiHome[]>(
    () =>
      summaries.map((home) => ({
        id: home.id,
        name: home.name,
        path: home.path,
        description: home.description,
        listed: home.listed,
        valid: home.valid,
        error: home.error,
        sessionsRoot: `${home.path}/sessions`,
      })),
    [summaries],
  )

  const home = useMemo(() => homes.find((item) => item.path === homePath) ?? null, [homes, homePath])
  const sessionsRoot = home?.sessionsRoot ?? (homePath ? `${homePath}/sessions` : '')

  const setHomePath = useCallback((path: string) => {
    useAppStore.setState({ homePath: path, homeValid: null, homeError: null })
  }, [])

  const switchHome = useCallback(
    async (path: string) => {
      if (path === useAppStore.getState().homePath) return true
      return confirmHome(path)
    },
    [confirmHome],
  )

  const refresh = refreshHomes
  const loading = homesLoading && homes.length === 0
  const error = homeValid === false && homeError ? homeError : null

  const value = useMemo<PiContextValue>(
    () => ({
      homes,
      loading,
      error,
      homePath,
      home,
      sessionsRoot,
      setHomePath,
      switchHome,
      refresh,
    }),
    [homes, loading, error, homePath, home, sessionsRoot, setHomePath, switchHome, refresh],
  )

  return <PiContext.Provider value={value}>{children}</PiContext.Provider>
}

export function usePi(): PiContextValue {
  const value = useContext(PiContext)
  if (!value) throw new Error('usePi 必须在 PiProvider 内使用')
  return value
}
