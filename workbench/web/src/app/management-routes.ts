import type { RouteObject } from 'react-router'
import { definitionRoutes } from '@/modules/definitions/routes'
import { configPatchRoutes } from '@/modules/patches/routes'

export const managementRoutes: RouteObject[] = [
  ...definitionRoutes,
  ...configPatchRoutes,
  { path: '/settings/agent-backends', handle: { title: 'Agent 后端' }, lazy: async () => ({ Component: (await import('@/modules/agent-backends/AgentBackends')).AgentBackends }) },
]
