import type { RouteObject } from 'react-router'

/** 两类包各自的列表与编辑台；应用装配只负责展开这组路由。 */
export const patchRoutes: RouteObject[] = [
  {
    path: '/work-patches',
    handle: { title: '工作包' },
    lazy: async () => ({ Component: (await import('./PatchList')).WorkPatchList }),
  },
  {
    path: '/work-patches/:id',
    handle: { title: '编辑工作包' },
    lazy: async () => ({ Component: (await import('./PatchStudio')).WorkPatchStudio }),
  },
  {
    path: '/work-patches/:id/execute',
    handle: { title: '运行工作包' },
    lazy: async () => ({ Component: (await import('./WorkPatchExecute')).WorkPatchExecute }),
  },
  {
    path: '/config-patches',
    handle: { title: '配置包' },
    lazy: async () => ({ Component: (await import('./PatchList')).ConfigPatchList }),
  },
  {
    path: '/config-patches/:id',
    handle: { title: '编辑配置包' },
    lazy: async () => ({ Component: (await import('./PatchStudio')).ConfigPatchStudio }),
  },
]
