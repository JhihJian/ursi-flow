import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/chat',
    lazy: async () => {
      const { default: View } = await import('./ChatView')
      return { Component: View }
    },
    handle: { title: '对话', description: '就当前工作流与运行记录向助手提问。', nav: true },
  },
  {
    path: '/chat/:sessionId',
    lazy: async () => {
      const { default: View } = await import('./ChatView')
      return { Component: View }
    },
    handle: { title: '对话详情', description: '查看历史消息并继续对话。' },
  },
]
