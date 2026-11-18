import type { RouteObject } from 'react-router'

export const routes: RouteObject[] = [
  {
    path: '/roles',
    lazy: async () => {
      const { default: View } = await import('./RolesView')
      return { Component: View }
    },
    handle: { title: '角色管理', description: '管理角色提示词、技能文件、MCP 与模型选择。', nav: true },
  },
]
