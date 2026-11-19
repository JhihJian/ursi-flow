import type { RouteObject } from 'react-router'

export const workspaceRoutes: RouteObject[] = [
  {
    path: 'workspaces',
    handle: { title: '线索报告工作区' },
    lazy: async () => ({ Component: (await import('./WorkspaceList')).WorkspaceList }),
  },
  {
    path: 'workspaces/new',
    handle: { title: '新建工作区' },
    lazy: async () => ({ Component: (await import('./NewWorkspace')).NewWorkspace }),
  },
  {
    path: 'workspaces/:id',
    handle: { title: '准备工作区' },
    lazy: async () => ({ Component: (await import('./WorkspacePrepare')).WorkspacePrepare }),
  },
  {
    path: 'workspaces/:id/result',
    handle: { title: '执行结果' },
    lazy: async () => ({ Component: (await import('./WorkspaceResult')).WorkspaceResult }),
  },
]
