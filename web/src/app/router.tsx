import { createBrowserRouter, Navigate, type RouteObject } from 'react-router'

import { routes as workflowRoutes } from '@/modules/workflows/routes'
import { routes as roleRoutes } from '@/modules/roles/routes'
import { routes as runRoutes } from '@/modules/runs/routes'
import { routes as artifactRoutes } from '@/modules/artifacts/routes'
import { routes as sandboxRoutes } from '@/modules/sandboxes/routes'
import { routes as connectionRoutes } from '@/modules/connections/routes'
import { routes as chatRoutes } from '@/modules/chat/routes'
import AppShell from './AppShell'
import NotFoundView from './NotFoundView'
import { RouteErrorAlert } from './RouteErrorAlert'

export interface NavigationItem {
  path: string
  title: string
  icon: string
}

export interface NavigationGroup {
  title: string
  items: NavigationItem[]
}

/** 一级导航的唯一来源，顺序即导航顺序。 */
export const navigation: NavigationItem[] = [
  { path: '/workflows', title: '工作流', icon: 'workflow' },
  { path: '/roles', title: '角色管理', icon: 'users' },
  { path: '/runs', title: '运行记录', icon: 'runs' },
  { path: '/chat', title: '对话', icon: 'chat' },
  { path: '/artifacts', title: '产物管理', icon: 'artifact' },
  { path: '/sandboxes', title: '沙箱管理', icon: 'server' },
  { path: '/connections', title: '模型连接', icon: 'connector' },
]

const groupPaths: Record<string, string[]> = {
  编排与协作: ['/workflows', '/roles', '/runs', '/chat'],
  资源与环境: ['/artifacts', '/sandboxes', '/connections'],
}

export const navigationGroups: NavigationGroup[] = Object.entries(groupPaths).map(([title, paths]) => ({
  title,
  items: navigation.filter((item) => paths.includes(item.path)),
}))

const domainRoutes: RouteObject[] = [
  ...workflowRoutes,
  ...roleRoutes,
  ...runRoutes,
  ...artifactRoutes,
  ...sandboxRoutes,
  ...connectionRoutes,
  ...chatRoutes,
]

/** 路由表：应用壳常驻，业务域在内容区内按需加载，加载失败时壳与重试入口保留。 */
export function createAppRoutes(): RouteObject[] {
  return [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <Navigate to="/workflows" replace /> },
        {
          errorElement: <RouteErrorAlert />,
          children: domainRoutes,
        },
        {
          path: '*',
          element: <NotFoundView />,
          handle: { title: '页面未找到', nav: false },
        },
      ],
    },
  ]
}

export function createAppRouter() {
  return createBrowserRouter(createAppRoutes())
}
