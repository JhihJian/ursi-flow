import type { RouteObject } from 'react-router'

export const workItemRoutes: RouteObject[] = [
  { path: 'work-items', handle: { title: '工作清单' }, lazy: async () => ({ Component: (await import('./WorkItems')).WorkItems }) },
  { path: 'work-items/new', handle: { title: '新建工作项' }, lazy: async () => ({ Component: (await import('./ItemEditor')).ItemEditor }) },
  { path: 'work-items/:id', handle: { title: '工作项详情' }, lazy: async () => ({ Component: (await import('./ItemDetail')).ItemDetail }) },
  { path: 'work-items/:id/edit', handle: { title: '编辑工作项' }, lazy: async () => ({ Component: (await import('./ItemEditor')).ItemEditor }) },
  { path: 'mcp-servers', handle: { title: '平台 MCP 服务' }, lazy: async () => ({ Component: (await import('./McpServers')).McpServers }) },
]
