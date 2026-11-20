import type { RouteObject } from 'react-router'

export const workListRoutes: RouteObject[] = [
  { path: 'items', handle: { title: '派工记录' }, lazy: async () => ({ Component: (await import('./WorkList')).WorkList }) },
  { path: 'items/new', handle: { title: '发起工作' }, lazy: async () => ({ Component: (await import('./StartWork')).StartWork }) },
]
