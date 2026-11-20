import { requestV2 } from '@/shared/http/client'

export type ServerDraft = { name: string; url: string; credentialEnv?: string }
export type McpServer = ServerDraft & { id: string }
export type McpResource = { name: string; uri: string; mimeType?: string; description?: string }
export type ResourceContent = { uri: string; mimeType?: string } & ({ text: string; blob?: never } | { blob: string; text?: never })
export type Inspection = {
  server: { name: string; version: string; protocolVersion: string; capabilities: { resources: boolean; tools: boolean; prompts: boolean } }
  resources: McpResource[]
}

const registryPath = '/mcp-servers'
export const serverBrowsePath = (id: string) => `${registryPath}/${encodeURIComponent(id)}`
export const listServers = (signal: AbortSignal) => requestV2<McpServer[]>(registryPath, { signal })
export const addServer = (draft: ServerDraft, signal: AbortSignal) =>
  requestV2<McpServer>(registryPath, { method: 'POST', body: JSON.stringify(draft), signal })
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
