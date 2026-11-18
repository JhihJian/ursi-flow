import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/runs',
    lazy: async () => {
      const { default: View } = await import('./RunsView')
      return { Component: View }
    },
    handle: { title: '运行记录', description: '追踪运行进度、查看执行事件并处理人工审批。', nav: true },
  },
  {
    path: '/runs/:id',
    lazy: async () => {
      const { default: View } = await import('./RunDetailView')
      return { Component: View }
    },
    handle: { title: '运行详情', description: '查看节点执行、事件、产物与冻结配置。' },
  },
]
