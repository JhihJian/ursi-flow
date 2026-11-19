import type { RouteObject } from 'react-router'

export const sourceRoutes: RouteObject[] = [
  { path: 'sources', handle: { title: '外部来源' }, lazy: async () => ({ Component: (await import('./Sources')).Sources }) },
  { path: 'sources/:provider/items', handle: { title: '来源条目' }, lazy: async () => ({ Component: (await import('./SourceItems')).SourceItems }) },
  { path: 'sources/:provider/items/:id', handle: { title: '来源条目详情' }, lazy: async () => ({ Component: (await import('./SourceItemDetail')).SourceItemDetail }) },
]
