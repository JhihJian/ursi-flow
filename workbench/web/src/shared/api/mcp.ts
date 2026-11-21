import { requestV2 } from '@/shared/http/client'

export type ServerDraft = { name: string; url: string; credentialEnv?: string }
export type McpSettings = { allowedTools: string[]; githubToolsets: string[]; githubReadOnly: boolean }
export type McpServer = ServerDraft & { id: string; settings?: McpSettings }
export type CatalogKind = 'tools' | 'prompts' | 'templates'
export type CatalogEntry = { name: string; description?: string; inputSchema?: object; arguments?: object[]; uriTemplate?: string }
export type McpResource = { name: string; title?: string; size?: number; uri: string; mimeType?: string; description?: string }
export type ResourceContent = { uri: string; mimeType?: string } & ({ text: string; blob?: never } | { blob: string; text?: never })
export type Inspection = {
  server: { name: string | null; version: string | null; title?: string; discoveryMethod: 'initialize' | 'server/discover'; supportedVersions: string[] | null; declaredCapabilities: Record<string, unknown>; instructions?: string; protocolVersion: string; capabilities: { resources: boolean; tools: boolean; prompts: boolean } }
  resources: McpResource[]
}

const registryPath = '/mcp-servers'
export const serverBrowsePath = (id: string) => `${registryPath}/${encodeURIComponent(id)}`
export const fetchCatalog = (id: string, kind: CatalogKind, signal: AbortSignal) => requestV2<CatalogEntry[]>(`${serverBrowsePath(id)}/catalog/${kind}`, { signal })
export const saveSettings = (id: string, settings: McpSettings, signal: AbortSignal) => requestV2<McpSettings>(`${serverBrowsePath(id)}/settings`, { method: 'PUT', body: JSON.stringify(settings), signal })
export const invoke = (id: string, kind: 'tools' | 'prompts', name: string, args: object, signal: AbortSignal) => requestV2<Record<string, unknown>>(`${serverBrowsePath(id)}/${kind === 'tools' ? 'tools/call' : 'prompts/get'}`, { method: 'POST', body: JSON.stringify({ name, arguments: args }), signal })
export const listServers = (signal: AbortSignal) => requestV2<McpServer[]>(registryPath, { signal })
export const addServer = (draft: ServerDraft, signal: AbortSignal) =>
  requestV2<McpServer>(registryPath, { method: 'POST', body: JSON.stringify({ ...draft, binding: 'platform' }), signal })
export const removeServer = (id: string, signal: AbortSignal) =>
  requestV2<{ id: string }>(serverBrowsePath(id), { method: 'DELETE', signal })
export const inspectServer = (id: string, signal: AbortSignal) =>
  requestV2<Inspection>(`${serverBrowsePath(id)}/inspection`, { signal })
export const listResources = (id: string, signal: AbortSignal) =>
  requestV2<McpResource[]>(`${serverBrowsePath(id)}/resources`, { signal })
export const readResource = (id: string, uri: string, signal: AbortSignal) =>
  requestV2<{ contents: ResourceContent[] }>(`${serverBrowsePath(id)}/resources/read`, {
    method: 'POST', body: JSON.stringify({ uri }), signal,
  })
