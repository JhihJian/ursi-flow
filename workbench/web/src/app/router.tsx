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
]
export function createAppRoutes(): RouteObject[] {
  return [{ path: '/', element: <AppShell />, children: [
    { index: true, element: <Navigate to="/work-items" replace /> },
    { errorElement: <RouteErrorAlert />, children: isLanPreview() ? [workAreaRoute] : [{ element: <LoginGate />, children: protectedRoutes }, ...chatRoutes] },
    { path: '*', element: <NotFoundView />, handle: { title: '页面未找到' } },
  ] }]
}
export function createAppRouter() { return createBrowserRouter(createAppRoutes()) }
