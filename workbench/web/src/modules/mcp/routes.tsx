import type { RouteObject } from 'react-router'

export const mcpRoutes: RouteObject[] = [
  { path: 'platform-env', handle: { title: '环境变量' }, lazy: async () => ({ Component: (await import('./PlatformEnvironment')).PlatformEnvironment }) },
  { path: 'mcp-servers', handle: { title: '平台 MCP 服务' }, lazy: async () => ({ Component: (await import('./McpServers')).McpServers }) },
  { path: 'mcp-servers/:id', handle: { title: 'MCP 服务检查' }, lazy: async () => ({ Component: (await import('./ResourceBrowser')).ResourceBrowser }) },
]
