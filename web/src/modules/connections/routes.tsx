import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/connections',
    lazy: async () => {
      const { default: View } = await import('./ConnectionsView')
      return { Component: View }
    },
    handle: { title: '模型连接', description: '配置模型服务端点、凭据引用与能力选择。', nav: true },
  },
]
