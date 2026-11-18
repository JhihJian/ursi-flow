import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'
import { routes as chatRoutes } from '@/modules/chat/routes'
import AppShell from './AppShell'
import { LoginGate } from './LoginGate'
import NotFoundView from './NotFoundView'
import { RouteErrorAlert } from './RouteErrorAlert'

export const navigationGroups = [
  { title: '运行工作区', items: [
    { path: '/flows', title: 'Flow 包', icon: 'workflow' },
    { path: '/runs', title: '运行记录', icon: 'runs' },
    { path: '/flow-config', title: '运行配置', icon: 'settings' },
  ] },
  { title: '本地演示', items: [{ path: '/chat', title: '对话', icon: 'chat' }] },
]
const protectedRoutes: RouteObject[] = [
  { path: 'flows', handle: { title: 'Flow 包' }, lazy: async () => ({ Component: (await import('@/modules/flows/Flows')).Flows }) },
  { path: 'flows/new', handle: { title: '创建 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'flows/:id/edit', handle: { title: '编辑 Flow' }, lazy: async () => ({ Component: (await import('@/modules/flows/FlowEditor')).FlowEditor }) },
  { path: 'runs', handle: { title: '运行记录' }, lazy: async () => ({ Component: (await import('@/modules/runs/Runs')).Runs }) },
  { path: 'runs/:id', handle: { title: '运行详情' }, lazy: async () => ({ Component: (await import('@/modules/runs/RunDetail')).RunDetail }) },
  { path: 'flow-config', handle: { title: '运行配置' }, lazy: async () => ({ Component: (await import('@/modules/config/Config')).Config }) },
]
export function createAppRoutes(): RouteObject[] {
  return [{ path: '/', element: <AppShell />, children: [
    { index: true, element: <Navigate to="/flows" replace /> },
    { errorElement: <RouteErrorAlert />, children: [{ element: <LoginGate />, children: protectedRoutes }, ...chatRoutes] },
    { path: '*', element: <NotFoundView />, handle: { title: '页面未找到' } },
  ] }]
}
export function createAppRouter() { return createBrowserRouter(createAppRoutes()) }
