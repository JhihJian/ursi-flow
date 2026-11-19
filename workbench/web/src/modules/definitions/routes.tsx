import { Navigate, type RouteObject } from 'react-router'
import { routePath, titles, type Collection } from './catalog'
import type { Page } from './DefinitionPage'

const collectionRoutes: RouteObject[] = (Object.keys(titles) as Collection[]).flatMap(k => {
  const route = (suffix: string, page: Page, title: string): RouteObject => ({
    path: `${routePath(k)}${suffix}`, handle: { title }, lazy: async () => {
      const { DefinitionPage } = await import('./DefinitionPage')
      return { Component: () => <DefinitionPage k={k} page={page} /> }
    },
  })
  return [route('', 'directory', k === 'resources' ? '资源库' : titles[k]), route('/new', 'editor', `新建${titles[k]}`),
    route('/:id', 'detail', titles[k]), route('/:id/revisions', 'history', '历史版本'), route('/:id/revisions/:revision', 'detail', `${titles[k]}版本`),
    route('/:id/edit', 'editor', `编辑${titles[k]}`), route('/:id/revisions/:revision/edit', 'editor', `编辑${titles[k]}`)]
})

export const definitionRoutes: RouteObject[] = [
  // 用户熟悉的 /packages 入口现在进入真正的工作包列表与新建，旧定义页面移到 /templates。
  { path: '/packages', element: <Navigate to="/workspaces" replace /> },
  { path: '/packages/new', element: <Navigate to="/workspaces/new" replace /> },
  ...collectionRoutes,
]
