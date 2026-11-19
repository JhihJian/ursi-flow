import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { routes as chatRoutes } from '@/modules/chat/routes'
import { workListRoutes } from '@/modules/work-list/routes'
import { workspaceRoutes } from '@/modules/workspaces/routes'
import { sourceRoutes } from '@/modules/sources/routes'
import { definitionRoutes } from '@/modules/definitions/routes'
import { sopRoutes } from '@/modules/sops/routes'
import AppShell from './AppShell'
import { LoginGate } from './LoginGate'
import NotFoundView from './NotFoundView'
import { RouteErrorAlert } from './RouteErrorAlert'

const workDetail = async () => ({ Component: (await import('@/modules/work-detail/WorkDetail')).WorkDetail })
const protectedRoutes: RouteObject[] = [
  ...workListRoutes,
  ...workspaceRoutes,
  { path: 'items/:id', handle: { title: '办理详情' }, lazy: workDetail },
  { path: 'items/:id/deliveries/:version', handle: { title: '交付与验收' }, lazy: workDetail },
  ...sourceRoutes,
  ...definitionRoutes,
  ...sopRoutes,
  { path: 'flows', handle: { title: 'Flow 包' }, lazy: async () => ({ Component: (await import('@/modules/flows/Flows')).Flows }) },
  { path: 'flows/new', handle: { title: '创建 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'flows/:id/edit', handle: { title: '编辑 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'runs', handle: { title: '运行记录' }, lazy: async () => ({ Component: (await import('@/modules/runs/Runs')).Runs }) },
  { path: 'runs/:id', handle: { title: '运行详情' }, lazy: async () => ({ Component: (await import('@/modules/runs/RunDetail')).RunDetail }) },
  { path: 'flow-config', handle: { title: '运行配置' }, lazy: async () => ({ Component: (await import('@/modules/config/Config')).Config }) },
]
export function createAppRoutes(): RouteObject[] {
  return [{ path: '/', element: <AppShell />, children: [
    { index: true, element: <Navigate to="/items" replace /> },
    { errorElement: <RouteErrorAlert />, children: [{ element: <LoginGate />, children: protectedRoutes }, ...chatRoutes] },
    { path: '*', element: <NotFoundView />, handle: { title: '页面未找到' } },
  ] }]
}
export function createAppRouter() { return createBrowserRouter(createAppRoutes()) }
