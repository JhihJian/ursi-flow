import { expect, it, vi } from 'vitest'
import { createMcpClient } from '../src/client'

it('只使用注入的传输，逐段编码服务 ID，保留 JSON 参数和取消信号', async () => {
  const request = vi.fn()
  const api = createMcpClient(async <T,>(path: string, options: RequestInit) => request(path, options) as T)
  const signal = new AbortController().signal
  const id = 'a/b ?'
  const base = '/mcp-servers/a%2Fb%20%3F'
  await api.listResources(id, signal)
  await api.readResource(id, 'memo:a?b', signal)
  await api.fetchCatalog(id, 'templates', signal)
  await api.invoke(id, 'prompts', 'report', { format: 'short' }, signal)
  await api.removeServer(id, signal)
  expect(request.mock.calls).toEqual([
    [`${base}/resources`, { signal }],
    [`${base}/resources/read`, { method: 'POST', body: JSON.stringify({ uri: 'memo:a?b' }), signal }],
    [`${base}/catalog/templates`, { signal }],
    [`${base}/prompts/get`, { method: 'POST', body: JSON.stringify({ name: 'report', arguments: { format: 'short' } }), signal }],
    [base, { method: 'DELETE', signal }],
  ])
})
