import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useMatches } from 'react-router'
import { createMcpClient, createMcpRoutes } from '../src'
import { useMutation } from '../src/lib/use-mutation'
import { Button } from '../src/ui/button'
import { Icon } from '../src/ui/icon'
import { Input } from '../src/ui/input'
import { getSession, request, restoreSession, signIn, signOut, subscribe } from './session'
import './styles.css'

const serverPath = '/mcp-servers'

function Login({ checking, message }: { checking: boolean; message: string }) {
  const [token, setToken] = useState('')
  const login = useMutation()
  const busy = checking || login.busy
  const error = login.error || message

  useEffect(() => { document.title = '登录 · mcp-web' }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const candidate = token.trim()
    if (!candidate || busy) return
    void login.run(signal => signIn(candidate, signal), () => setToken(''))
  }

  return <main className="mcp-web host-login">
    <form className="panel host-login-form" method="post" autoComplete="off" onSubmit={submit}>
      <div className="host-brand"><Icon name="connector" size={20} /> mcp-web</div>
      <h1>登录 MCP 管理台</h1>
      <label className="host-field">
        <span>访问令牌</span>
        <Input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={token}
          disabled={busy} onChange={event => setToken(event.target.value)} />
      </label>
      {error && !busy && <p role="alert" className="host-error">{error}</p>}
      {busy && <p role="status" className="host-muted">正在验证令牌…</p>}
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!token.trim()}>登录</Button>
    </form>
  </main>
}

function Shell() {
  const session = useSyncExternalStore(subscribe, getSession)
  const title = useMatches().reduce<string | undefined>(
    (parentTitle, match) => (match.handle as { title?: string } | undefined)?.title ?? parentTitle, undefined,
  )
  useEffect(() => {
    if (session.token) document.title = title ? `${title} · mcp-web` : 'mcp-web'
  }, [session.token, title])

  // Keeping the original address lets login resume the exact deep link, including its query.
  if (!session.token) return <Login checking={session.checking} message={session.message} />
  return <>
    <a className="host-skip" href="#main-content">跳到主要内容</a>
    <header className="host-top">
      <div className="host-width host-bar">
        <Link to={serverPath} className="host-brand"><Icon name="connector" size={20} /> mcp-web</Link>
        <div className="mcp-web host-logout"><Button icon="logout" onClick={() => signOut()}>退出登录</Button></div>
      </div>
    </header>
    <main id="main-content" tabIndex={-1} className="host-width host-content"><Outlet /></main>
  </>
}

function RouteMessage({ error = false }: { error?: boolean }) {
  return <section role={error ? 'alert' : undefined} className="host-route-message">
    <h1>{error ? '页面加载失败' : '页面未找到'}</h1>
    {error && <button type="button" onClick={() => window.location.reload()}>重新打开页面</button>}
    <Link to={serverPath}>返回 MCP 服务</Link>
  </section>
}

const router = createBrowserRouter([{
  element: <Shell />,
  hydrateFallbackElement: <p className="host-width host-content" role="status">正在加载…</p>,
  children: [{
    errorElement: <RouteMessage error />,
    children: [
      { index: true, element: <Navigate to={serverPath} replace /> },
      ...createMcpRoutes({ client: createMcpClient(request) }),
      { path: '*', handle: { title: '页面未找到' }, element: <RouteMessage /> },
    ],
  }],
}])

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载点。')
createRoot(root).render(<RouterProvider router={router} />)
void restoreSession()
