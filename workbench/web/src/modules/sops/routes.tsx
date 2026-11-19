import type { RouteObject } from 'react-router'

export const sopRoutes: RouteObject[] = [
  { path: 'sops', handle: { title: 'SOP 管理' }, lazy: async () => ({ Component: (await import('./Sops')).Sops }) },
  { path: 'sops/new', handle: { title: '发布 SOP' }, lazy: async () => ({ Component: (await import('./SopEditor')).SopEditor }) },
  { path: 'sops/:id/revisions/:revision/edit', handle: { title: '发布 SOP 新版' }, lazy: async () => ({ Component: (await import('./SopEditor')).SopEditor }) },
  { path: 'sops/:id/revisions/:revision', handle: { title: 'SOP 修订' }, lazy: async () => ({ Component: (await import('./SopPage')).SopVersionPage }) },
  { path: 'sops/:id/revisions', handle: { title: 'SOP 修订历史' }, lazy: async () => ({ Component: (await import('./SopPage')).SopHistory }) },
  { path: 'sops/:id', handle: { title: 'SOP 修订历史' }, lazy: async () => ({ Component: (await import('./SopPage')).SopHistory }) },
]
