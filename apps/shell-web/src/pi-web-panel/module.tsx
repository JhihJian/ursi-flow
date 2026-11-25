import { useEffect, useState } from 'react'
import type { CollapsedSummary, WorkspaceModule } from '@ursi/workspace-shell'

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

function PiWebPanel({ url }: { url: string }) {
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

  return (
    <div className="piweb-panel">
      <iframe
        key={`${url}-${attempt}`}
        className="piweb-frame"
        src={embedUrl(url)}
        title="pi-web"
        allow="fullscreen; clipboard-read; clipboard-write"
        onLoad={() => setReachable(true)}
      />
      {!reachable && (
        <div className="piweb-offline" role="status">
          <span className="piweb-offline-title">pi-web 未启动</span>
          <span className="piweb-offline-text">
            请在 apps/pi-web 运行 <code>npm run dev:lan</code>（0.0.0.0:30141）。
          </span>
          <button type="button" className="piweb-retry" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
    </div>
  )
}

export function createPiWebModule(options: PiWebModuleOptions = {}): WorkspaceModule {
  const url = resolveUrl(options.url)
  return {
    id: 'pi-web',
    title: 'pi-web',
    /** pi-web 自带顶栏与侧边栏，外壳不再画标题行。 */
    hideHeader: true,
    /** 折叠时保留 iframe 挂载，避免会话、终端、草稿被重置。 */
    keepMounted: true,
    defaultSize: 560,
    minSize: 360,
    /** iframe 内容需要更宽的可用空间。 */
    maxSize: 1100,
    Panel: () => <PiWebPanel url={url} />,
    useCollapsedSummary: (): CollapsedSummary => ({
      title: 'pi-web',
      items: [{ label: 'port', value: String(DEFAULT_PORT) }],
    }),
    actions: [],
  }
}
