import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/sandboxes',
    lazy: async () => {
      const { default: SandboxesView } = await import('./SandboxesView')
      return { Component: SandboxesView }
    },
    handle: { title: '沙箱管理', description: '查看执行资源、运行关联与获准的访问入口。', nav: true },
  },
]
