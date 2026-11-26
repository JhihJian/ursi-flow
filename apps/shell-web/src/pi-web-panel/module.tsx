import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  SidebarFrame,
  type ModuleSidebarProps,
  type WorkspaceModule,
} from '@ursi/workspace-shell'

export interface PiWebModuleOptions {
  /** 覆盖 pi-web 地址，缺省按当前窗口 hostname + 端口 30141 推导。 */
  url?: string
}

const DEFAULT_PORT = 30141
const CHECK_INTERVAL = 5000

function resolveUrl(optionUrl?: string): string {
  const base = (optionUrl ?? import.meta.env.VITE_PI_WEB_URL ?? '').trim()
  if (base) return base.replace(/\/+$/, '')
  const host =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : '127.0.0.1'
  const protocol = typeof window !== 'undefined' ? window.location.protocol : 'http:'
  return `${protocol}//${host}:${DEFAULT_PORT}`
}

function embedUrl(base: string): string {
  const url = new URL(base, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
  url.searchParams.set('embed', '1')
  return url.toString()
}

async function isReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) })
    return true
  } catch {
    return false
  }
}

interface PiWebStatus {
  reachable: boolean
  attempt: number
  retry: () => void
}

const StatusContext = createContext<PiWebStatus | null>(null)

function usePiWebStatus(): PiWebStatus {
  const value = useContext(StatusContext)
  if (!value) throw new Error('pi-web: 缺少 PiWebStatusProvider')
  return value
}

/** 连通性探测放在 Provider：侧边栏与工作区共用一份结果，不重复轮询。 */
function PiWebStatusProvider({ url, children }: { url: string; children: ReactNode }) {
  const [reachable, setReachable] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      const ok = await isReachable(url)
      if (cancelled) return
      setReachable(ok)
      timer = setTimeout(check, CHECK_INTERVAL)
    }
    void check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [url, attempt])

  const retry = () => setAttempt((current) => current + 1)
  return (
    <StatusContext.Provider value={{ reachable, attempt, retry }}>
      {children}
    </StatusContext.Provider>
  )
}

function PiWebSidebar({ collapsed, collapse, expand }: ModuleSidebarProps) {
  const { reachable, retry } = usePiWebStatus()
  return (
    <SidebarFrame
      title="pi-web"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={[
        { label: '状态', value: reachable ? '在线' : '未连接' },
        { label: '端口', value: String(DEFAULT_PORT) },
      ]}
    >
      <div className="piweb-side">
        <p className="piweb-side-line">本机 Pi agent，浏览器里直接使用会话、工具与终端。</p>
        <p className="piweb-side-line">与 CLI 共享 ~/.pi/agent 的模型、会话、技能与 MCP 配置。</p>
        <button type="button" className="piweb-retry" onClick={retry}>
          重试连接
        </button>
      </div>
    </SidebarFrame>
  )
}

function PiWebWorkspace({ url }: { url: string }) {
  const { reachable, attempt, retry } = usePiWebStatus()
  return (
    <div className="piweb-panel">
      <iframe
        key={`${url}-${attempt}`}
        className="piweb-frame"
        src={embedUrl(url)}
        title="pi-web"
        allow="fullscreen; clipboard-read; clipboard-write"
      />
      {!reachable && (
        <div className="piweb-offline" role="status">
          <span className="piweb-offline-title">pi-web 未启动</span>
          <span className="piweb-offline-text">
            请在 apps/pi-web 运行 <code>npm run dev:lan</code>（0.0.0.0:{DEFAULT_PORT}）。
          </span>
          <button type="button" className="piweb-retry" onClick={retry}>
            重试
          </button>
        </div>
      )}
    </div>
  )
}

export function createPiWebModule(options: PiWebModuleOptions = {}): WorkspaceModule {
  const url = resolveUrl(options.url)
  const Provider = ({ children }: { children: ReactNode }) => (
    <PiWebStatusProvider url={url}>{children}</PiWebStatusProvider>
  )
  const Workspace = () => <PiWebWorkspace url={url} />

  return {
    id: 'pi-web',
    title: 'pi-web',
    Provider,
    Sidebar: PiWebSidebar,
    Workspace,
    context: {
      Status: () => {
        const { reachable } = usePiWebStatus()
        return <span>pi-web {reachable ? '在线' : '未连接'}</span>
      },
    },
    /** 折叠时保留 iframe，避免会话、终端、草稿被重置。 */
    keepMounted: true,
    actions: [],
  }
}
