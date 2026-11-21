export type McpRequest = <T>(path: string, options: RequestInit) => Promise<T>
export type ServerDraft = { name: string; url: string; credentialEnv?: string }
export type McpSettings = { allowedTools: string[]; githubToolsets: string[]; githubReadOnly: boolean }
export type ProtocolCheck = {
  status: 'declaredV1' | 'notDeclared' | 'unsupportedVersion' | 'invalidDeclaration' | 'legacy'
  checkedAt: number
}
export type McpServer = ServerDraft & { id: string; settings?: McpSettings; protocolCheck?: ProtocolCheck }
export type CatalogKind = 'tools' | 'prompts' | 'templates'
export type CatalogEntry = { name: string; description?: string; inputSchema?: object; arguments?: object[]; uriTemplate?: string }
export type McpResource = { name: string; title?: string; size?: number; uri: string; mimeType?: string; description?: string }
export type ResourceContent = { uri: string; mimeType?: string } & ({ text: string; blob?: never } | { blob: string; text?: never })
export type Inspection = {
  server: { name: string | null; version: string | null; title?: string; discoveryMethod: 'initialize' | 'server/discover'; supportedVersions: string[] | null; declaredCapabilities: Record<string, unknown>; instructions?: string; protocolVersion: string; capabilities: { resources: boolean; tools: boolean; prompts: boolean } }
  resources: McpResource[]
}

const registry = '/mcp-servers'
const serverPath = (id: string) => `${registry}/${encodeURIComponent(id)}`

/** 路径相对宿主 API 根，鉴权、错误处理和 JSON 解码均由 request 负责。 */
export function createMcpClient(request: McpRequest) {
  return {
    listServers: (signal: AbortSignal) => request<McpServer[]>(registry, { signal }),
    addServer: (draft: ServerDraft, signal: AbortSignal) => request<McpServer>(registry, {
      method: 'POST', body: JSON.stringify({ ...draft, binding: 'platform' }), signal,
    }),
    removeServer: (id: string, signal: AbortSignal) => request<{ id: string }>(serverPath(id), { method: 'DELETE', signal }),
    inspectServer: (id: string, signal: AbortSignal) => request<Inspection>(`${serverPath(id)}/inspection`, { signal }),
    checkProtocol: (id: string, signal: AbortSignal) => request<ProtocolCheck>(`${serverPath(id)}/protocol-check`, { method: 'POST', signal }),
    listResources: (id: string, signal: AbortSignal) => request<McpResource[]>(`${serverPath(id)}/resources`, { signal }),
    readResource: (id: string, uri: string, signal: AbortSignal) => request<{ contents: ResourceContent[] }>(`${serverPath(id)}/resources/read`, {
      method: 'POST', body: JSON.stringify({ uri }), signal,
    }),
    fetchCatalog: (id: string, kind: CatalogKind, signal: AbortSignal) => request<CatalogEntry[]>(`${serverPath(id)}/catalog/${kind}`, { signal }),
    saveSettings: (id: string, settings: McpSettings, signal: AbortSignal) => request<McpSettings>(`${serverPath(id)}/settings`, {
      method: 'PUT', body: JSON.stringify(settings), signal,
    }),
    invoke: (id: string, kind: 'tools' | 'prompts', name: string, args: object, signal: AbortSignal) => request<Record<string, unknown>>(`${serverPath(id)}/${kind === 'tools' ? 'tools/call' : 'prompts/get'}`, {
      method: 'POST', body: JSON.stringify({ name, arguments: args }), signal,
    }),
  }
}
export type McpClient = ReturnType<typeof createMcpClient>
