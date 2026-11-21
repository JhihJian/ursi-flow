import { createMcpRoutes } from '@ursi/mcp-web'
import type { RouteObject } from 'react-router'
import { mcpClient } from '@/shared/api/mcp'
import { listVariables } from '@/shared/api/platform-env'

export const mcpRoutes: RouteObject[] = [
  { path: 'platform-env', handle: { title: '环境变量' }, lazy: async () => ({ Component: (await import('./PlatformEnvironment')).PlatformEnvironment }) },
  ...createMcpRoutes({ client: mcpClient, listVariableNames: listVariables, variableManagementPath: '/platform-env' }),
]
