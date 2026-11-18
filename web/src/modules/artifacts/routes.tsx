import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/artifacts',
    lazy: async () => {
      const { default: ArtifactsView } = await import('./ArtifactsView')
      return { Component: ArtifactsView }
    },
    handle: { title: '产物管理', description: '查阅运行交付物，追溯节点与执行轮次。', nav: true },
  },
]
