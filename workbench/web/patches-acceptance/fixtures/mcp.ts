import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const mcpResource = { name: '周报', uri: 'feedback://weekly', text: '本周反馈原文' }
export const mcpToken = 'fixture-token'

/** 同一个回环服务覆盖新版发现和旧版握手，工作台仍使用真实 MCP 客户端。 */
export async function startMcpFixture(modern: boolean, beforeRead?: () => Promise<void>) {
  const toolCalls: unknown[] = []
  const resourceReads: string[] = []
  const { name, uri, text } = mcpResource
  const peer = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${mcpToken}`) { res.writeHead(401).end(); return }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    const body = []
    for await (const bytes of req) body.push(bytes)
    const rpc = JSON.parse(Buffer.concat(body).toString())
    if (rpc.method === 'server/discover' && !modern) { res.writeHead(400).end(); return }
    if (modern && (rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || req.headers['mcp-protocol-version'] !== '2026-07-28')) { res.writeHead(422).end(); return }
    if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return }
    const result = rpc.method === 'server/discover' ? {
      supportedVersions: ['2026-07-28', '2025-06-18'], capabilities: { resources: { listChanged: true }, tools: {}, prompts: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: '现代服务', version: '2' } },
    } : rpc.method === 'initialize' ? {
      protocolVersion: '2025-06-18', capabilities: { resources: {}, tools: {}, prompts: {} }, serverInfo: { name: '反馈', version: '1' },
    } : rpc.method === 'resources/list' ? { resources: [{ name, uri }] }
      : rpc.method === 'tools/list' ? (rpc.params?.cursor ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'two' })
      : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: '回声结果' }] }
      : rpc.method === 'prompts/list' ? { prompts: [{ name: 'welcome', arguments: [{ name: 'user' }] }] }
      : rpc.method === 'prompts/get' ? { messages: [{ role: 'user', content: { type: 'text', text: `你好 ${rpc.params.arguments.user}` } }] }
      : rpc.method === 'resources/templates/list' ? { resourceTemplates: [{ name: '周报模板', uriTemplate: 'feedback://{week}' }] }
      : rpc.method === 'resources/read' && rpc.params.uri === uri ? { contents: [{ uri, text }] }
      : undefined
    res.setHeader('content-type', 'application/json')
    if (!result) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unknown fixture request' } }))
      return
    }
    if (rpc.method === 'tools/call') toolCalls.push(rpc.params.arguments)
    if (rpc.method === 'resources/read') {
      resourceReads.push(uri)
      await beforeRead?.()
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result } : result }))
  })
  await new Promise<void>((resolve, reject) => {
    peer.once('error', reject)
    peer.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}/mcp`,
    toolCalls,
    resourceReads,
    async close() {
      await new Promise<void>((resolve, reject) => {
        peer.close(cause => cause ? reject(cause) : resolve())
        peer.closeAllConnections()
      })
    },
  }
}
