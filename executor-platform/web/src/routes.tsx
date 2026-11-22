import { useSyncExternalStore } from 'react'
import { Link, Navigate, NavLink, Outlet, type RouteObject } from 'react-router'
import { LoginGate } from '@/app/LoginGate'
import { managementRoutes } from '@/app/management-routes'
import { RouteErrorAlert } from '@/app/RouteErrorAlert'
import { FeedbackHost } from '@/app/FeedbackHost'
import { readToken, setToken, subscribeSession } from '@/shared/http/session'
import { Button } from '@/shared/ui/button'

const sections = [['/executors', '执行器'], ['/config-patches', '配置包'], ['/resources', '资源库'], ['/settings/agent-backends', 'Agent 后端']]
function ManagementShell() {
  const token = useSyncExternalStore(subscribeSession, readToken)
  return <div className="flex min-h-dvh flex-col">
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-surface px-4 py-3">
      <Link className="font-semibold" to="/executors">执行器管理平台</Link>
      <nav aria-label="平台管理" className="flex flex-wrap gap-1">{sections.map(([path, title]) => <NavLink key={path} to={path} className={({ isActive }) => `sidebar-link ${isActive ? 'nav-active' : ''}`}>{title}</NavLink>)}</nav>
      {token && <Button className="ml-auto" variant="ghost" icon="logout" onClick={() => setToken('')}>退出登录</Button>}
    </header>
    <main className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col p-4 md:p-6"><Outlet /></main>
    <FeedbackHost />
  </div>
}
export const routes: RouteObject[] = [{ element: <ManagementShell />, children: [
  { index: true, element: <Navigate to="/executors" replace /> },
  { element: <LoginGate title="登录执行器管理平台" />, errorElement: <RouteErrorAlert />, children: managementRoutes },
  { path: '*', element: <section><h1>页面未找到</h1><Link className="text-accent-2" to="/executors">返回执行器目录</Link></section> },
] }]
