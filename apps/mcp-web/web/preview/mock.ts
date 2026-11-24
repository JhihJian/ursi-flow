import type {
  CatalogEntry, Inspection, McpRequest, McpResource, McpServer, ProtocolCheck, RecognitionRule, ResourceContent,
} from '../src/client'

const now = Date.now()
const hour = 3_600_000

let servers: McpServer[] = [
  {
    id: 'github', name: 'GitHub 企业服务', url: 'https://mcp.github.internal/mcp', credentialEnv: 'TEAM_TOKEN',
    protocolCheck: { status: 'checked', checkedAt: now - hour, labels: ['github-enterprise'] },
    settings: { allowedTools: ['search_repositories', 'get_issue'], githubToolsets: ['repos', 'issues'], githubReadOnly: false },
  },
  {
    id: 'docs', name: '文档检索', url: 'https://mcp.docs.internal/mcp', credentialSecret: true,
    protocolCheck: { status: 'legacy', checkedAt: now - 24 * hour, labels: [] },
    settings: { allowedTools: ['search_docs'], githubToolsets: [], githubReadOnly: false },
  },
  {
    id: 'sandbox', name: '沙箱执行器', url: 'https://mcp.sandbox.internal/mcp',
    protocolCheck: { status: 'checked', checkedAt: now - 2 * hour, labels: ['ursi-executor'] },
    settings: { allowedTools: [], githubToolsets: [], githubReadOnly: false },
  },
]

let rules: RecognitionRule[] = [
  { id: 'github-enterprise', label: 'GitHub 企业版', metaKey: 'ursi/executorProtocol', equals: 'github' },
  { id: 'ursi-executor', label: 'URSI 执行器', metaKey: 'ursi/executorProtocol', equals: '1' },
]

const tools: CatalogEntry[] = [
  { name: 'search_repositories', description: '按关键词检索代码仓库，支持分页与排序。', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '检索关键词' }, limit: { type: 'integer', description: '返回数量上限' }, archived: { type: 'boolean', description: '是否包含已归档仓库' }, sort: { type: 'string', enum: ['stars', 'updated', 'name'], description: '排序方式' } }, required: ['query'] } },
  { name: 'get_issue', description: '读取指定仓库的单个工单。', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] } },
  { name: 'list_commits', description: '列出仓库提交历史。', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, since: { type: 'string', description: '起始时间（ISO 8601）' } } } },
]

const prompts: CatalogEntry[] = [
  { name: 'summarize_issue', description: '用一段话总结工单的目标、现状与阻塞点。' },
  { name: 'explain_code', description: '解释一段代码片段的作用与潜在问题。' },
]

const templates: CatalogEntry[] = [
  { name: 'repo_file', uriTemplate: 'repo://{owner}/{repo}/file/{path}', description: '读取仓库内的单个文件。' },
  { name: 'issue', uriTemplate: 'repo://{owner}/{repo}/issue/{number}', description: '读取单个工单内容。' },
]

const resources: McpResource[] = [
  { name: 'readme', title: 'README.md', uri: 'repo://acme/web/README.md', mimeType: 'text/markdown', description: '项目说明与快速上手。' },
  { name: 'manifest', title: 'package.json', uri: 'repo://acme/web/package.json', mimeType: 'application/json' },
  { name: 'logo', title: 'logo.png', uri: 'repo://acme/web/assets/logo.png', mimeType: 'image/png', size: 20480 },
  { name: 'changelog', title: 'CHANGELOG.md', uri: 'repo://acme/web/CHANGELOG.md', mimeType: 'text/markdown' },
]

function inspection(id: string): Inspection {
  const server = servers.find(s => s.id === id)!
  return {
    server: {
      name: server.name, version: '2.4.1', title: `${server.name} · MCP`, discoveryMethod: 'initialize',
      supportedVersions: ['2024-11-05', '2025-03-26'],
      declaredCapabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: false },
        logging: { level: 'debug' },
      },
      instructions: '用于样式预览的示例 MCP 服务，所有返回均为本地模拟数据。',
      protocolVersion: '2025-03-26',
      capabilities: { resources: true, tools: true, prompts: true },
    },
    resources,
  }
}

function readContents(uri: string): { contents: ResourceContent[] } {
  if (uri.endsWith('.png')) {
    return { contents: [{ uri, mimeType: 'image/png', blob: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }] }
  }
  if (uri.endsWith('.json')) {
    return { contents: [{ uri, mimeType: 'application/json', text: '{\n  "name": "acme-web",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "build": "vite build"\n  }\n}' }] }
  }
  return { contents: [{ uri, mimeType: 'text/markdown', text: '# 项目说明\n\n这是用于样式预览的示例正文。\n\n## 快速上手\n\n1. 安装依赖\n2. 启动开发服务器\n3. 打开浏览器访问\n\n> 注：所有内容均为本地模拟数据，不会发起真实请求。\n\n```ts\nconst answer = 42\n```' }] }
}

function toolResult(): Record<string, unknown> {
  return {
    isError: false,
    structuredContent: {
      total_count: 3,
      items: [
        { id: 1, full_name: 'acme/ursi-flow', stars: 128, url: 'https://github.com/acme/ursi-flow', archived: false },
        { id: 2, full_name: 'acme/mcp-web', stars: 64, url: 'https://github.com/acme/mcp-web', archived: false },
        { id: 3, full_name: 'acme/legacy', stars: 7, url: 'https://github.com/acme/legacy', archived: true },
      ],
      next_cursor: 'eyJwYWdlIjoyfQ',
    },
  }
}

function promptResult(): Record<string, unknown> {
  return { description: '总结工单', messages: [{ role: 'user', content: { type: 'text', text: '请总结该工单的目标、现状与阻塞点。' } }] }
}

/** 本地模拟请求：按路径与方法返回固定数据，让预览页无需后端即可完整浏览。 */
export const mockRequest: McpRequest = async function <T>(path: string, options: RequestInit): Promise<T> {
  await new Promise(resolve => setTimeout(resolve, 140))
  const method = options.method ?? 'GET'
  const body: Record<string, unknown> | undefined = typeof options.body === 'string' ? JSON.parse(options.body) as Record<string, unknown> : undefined

  if (path === '/mcp-recognition-rules') {
    if (method === 'PUT' && Array.isArray(body)) rules = body as unknown as RecognitionRule[]
    return rules as unknown as T
  }

  if (path === '/mcp-servers') {
    if (method === 'POST') {
      const draft = body as unknown as { name: string; url: string; credentialEnv?: string; credentialSecret?: string }
      const server: McpServer = {
        id: `srv-${Date.now()}`, name: draft.name, url: draft.url,
        credentialEnv: draft.credentialEnv, credentialSecret: Boolean(draft.credentialSecret),
        settings: { allowedTools: [], githubToolsets: [], githubReadOnly: false },
      }
      servers = [...servers, server]
      return server as unknown as T
    }
    return servers as unknown as T
  }

  const match = path.match(/^\/mcp-servers\/([^/]+)(?:\/(.*))?$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    const rest = match[2] ?? ''
    const server = servers.find(s => s.id === id)
    if (!server) throw new Error('未找到该服务')

    if (rest === '' && method === 'DELETE') { servers = servers.filter(s => s.id !== id); return { id } as unknown as T }
    if (rest === 'inspection') return inspection(id) as unknown as T
    if (rest === 'protocol-check') {
      const result: ProtocolCheck = { status: 'checked', checkedAt: Date.now(), labels: ['github-enterprise'] }
      server.protocolCheck = result
      return result as unknown as T
    }
    if (rest === 'catalog/tools') return tools as unknown as T
    if (rest === 'catalog/prompts') return prompts as unknown as T
    if (rest === 'catalog/templates') return templates as unknown as T
    if (rest === 'resources') return resources as unknown as T
    if (rest === 'resources/read') return readContents(typeof body?.uri === 'string' ? body.uri : '') as unknown as T
    if (rest === 'tools/call') return toolResult() as unknown as T
    if (rest === 'prompts/get') return promptResult() as unknown as T
    if (rest === 'settings') {
      const settings = body as unknown as McpServer['settings']
      server.settings = settings
      return settings as unknown as T
    }
  }

  throw new Error(`未模拟的请求：${method} ${path}`)
}
