import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/workflows',
    lazy: async () => {
      const { default: WorkflowsView } = await import('./WorkflowsView')
      return { Component: WorkflowsView }
    },
    handle: { title: '工作流', description: '编排流程定义，查看节点依赖并发起运行。', nav: true },
  },
]
