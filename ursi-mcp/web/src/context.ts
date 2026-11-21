import { createContext, useContext } from 'react'
import type { McpClient } from './client'

export type McpRouteOptions = {
  client: McpClient
  listVariableNames: (signal: AbortSignal) => Promise<string[]>
  variableManagementPath: string
}
export const McpContext = createContext<McpRouteOptions | null>(null)
export function useMcp() {
  const options = useContext(McpContext)
  if (!options) throw new Error('MCP 页面需要通过 createMcpRoutes 挂载')
  return options
}
