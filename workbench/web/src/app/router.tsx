import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { routes as chatRoutes } from '@/modules/chat/routes'
import { workAreaRoute } from '@/modules/workspace/routes'
import { workPatchGeneratorRoutes } from '@/modules/work-patch-generators/routes'
import { mcpRoutes } from '@/modules/mcp/routes'
import { workPatchRoutes } from '@/modules/patches/routes'
import { managementRoutes } from './management-routes'
import AppShell from './AppShell'
import { LoginGate } from './LoginGate'
import NotFoundView from './NotFoundView'
import { RouteErrorAlert } from './RouteErrorAlert'
import { isLanPreview } from '@/shared/http/lan-preview'

const protectedRoutes: RouteObject[] = [
  workAreaRoute,
  ...workPatchGeneratorRoutes,
  ...mcpRoutes,
  ...workPatchRoutes,
  ...managementRoutes,
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
    { errorElement: <RouteErrorAlert />, children: isLanPreview() ? [workAreaRoute] : [{ element: <LoginGate />, children: protectedRoutes }, ...chatRoutes] },
    { path: '*', element: <NotFoundView />, handle: { title: '页面未找到' } },
  ] }]
}
export function createAppRouter() { return createBrowserRouter(createAppRoutes()) }
