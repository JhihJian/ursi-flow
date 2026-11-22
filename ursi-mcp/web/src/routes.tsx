import { Outlet, type RouteObject } from 'react-router'
import { McpContext, type McpRouteOptions } from './context'
import { FeedbackProvider } from './ui/feedback'
import './styles.css'

export function createMcpRoutes(options: McpRouteOptions): RouteObject[] {
  return [{
    element: <McpContext.Provider value={options}><div className="ursi-mcp"><FeedbackProvider><Outlet /></FeedbackProvider></div></McpContext.Provider>,
    children: [
      { path: 'mcp-recognition-rules', handle: { title: 'MCP 识别规则' }, lazy: async () => ({ Component: (await import('./pages/RecognitionRules')).RecognitionRules }) },
      { path: 'mcp-servers', handle: { title: '平台 MCP 服务' }, lazy: async () => ({ Component: (await import('./pages/McpServers')).McpServers }) },
      { path: 'mcp-servers/:id', handle: { title: 'MCP 服务检查' }, lazy: async () => ({ Component: (await import('./pages/ResourceBrowser')).ResourceBrowser }) },
    ],
  }]
}
