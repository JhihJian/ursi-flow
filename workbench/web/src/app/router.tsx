import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { routes as chatRoutes } from '@/modules/chat/routes'
import { workItemRoutes } from '@/modules/work-items/routes'
import { patchRoutes } from '@/modules/patches/routes'
import { definitionRoutes } from '@/modules/definitions/routes'
import AppShell from './AppShell'
import { LoginGate } from './LoginGate'
import NotFoundView from './NotFoundView'
import { RouteErrorAlert } from './RouteErrorAlert'

const protectedRoutes: RouteObject[] = [
  ...workItemRoutes,
  ...patchRoutes,
  ...definitionRoutes,
  { path: 'flows', handle: { title: 'Flow 包' }, lazy: async () => ({ Component: (await import('@/modules/flows/Flows')).Flows }) },
  { path: 'flows/new', handle: { title: '创建 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'flows/:id/edit', handle: { title: '编辑 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'runs', handle: { title: '运行记录' }, lazy: async () => ({ Component: (await import('@/modules/runs/Runs')).Runs }) },
  { path: 'runs/:id', handle: { title: '运行详情' }, lazy: async () => ({ Component: (await import('@/modules/runs/RunDetail')).RunDetail }) },
  { path: 'flow-config', handle: { title: '运行配置' }, lazy: async () => ({ Component: (await import('@/modules/config/Config')).Config }) },
]
export function createAppRoutes(): RouteObject[] {
  return [{ path: '/', element: <AppShell />, children: [
    { index: true, element: <Navigate to="/work-items" replace /> },
    { errorElement: <RouteErrorAlert />, children: [{ element: <LoginGate />, children: protectedRoutes }, ...chatRoutes] },
    { path: '*', element: <NotFoundView />, handle: { title: '页面未找到' } },
  ] }]
}
export function createAppRouter() { return createBrowserRouter(createAppRoutes()) }
