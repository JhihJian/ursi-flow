import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestJson, requestV2, requestV2File } from './client'
import { readToken, setToken } from './session'

beforeEach(() => setToken('session-canary'))
afterEach(() => sessionStorage.clear())
describe('Runtime HTTP', () => {
  it('保留直接 JSON 与取消信号，只在请求头携带令牌', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(['example']))
    vi.stubGlobal('fetch', fetch)
    const { signal } = new AbortController()
    await expect(requestJson('/flows', { signal })).resolves.toEqual(['example'])
    expect(fetch).toHaveBeenCalledWith('/api/v1/flows', expect.objectContaining({ signal, headers: expect.any(Headers) }))
    expect(fetch.mock.calls[0]![1].headers.get('Authorization')).toBe('Bearer session-canary')
    expect(localStorage.length).toBe(0)
  })
  it.each([requestJson, requestV2, requestV2File])('无令牌不发请求，拒绝绝对地址', async request => {
    vi.stubGlobal('fetch', vi.fn()); setToken('')
    await expect(request('/example')).rejects.toMatchObject({ status: 401 })
    await expect(request('https://invalid.test')).rejects.toThrow(TypeError)
    await expect(request('//invalid.test')).rejects.toThrow(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('401 清除失效会话，错误消息不回显令牌', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'session-canary' }, { status: 401 })))
    await expect(requestJson('/flows')).rejects.toThrow('HTTP 401：[已隐藏]')
    expect(readToken()).toBe('')
  })
  it('v2 JSON 请求支持写入并保留请求参数', async () => {
    const fetch = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ id: 'item-1' }))
    vi.stubGlobal('fetch', fetch)
    const { signal } = new AbortController()
    const body = JSON.stringify({ title: '周报', category: 'continuous', description: '', recipe: null })
    await expect(requestV2('/work-items', { method: 'POST', signal, body })).resolves.toEqual({ id: 'item-1' })
    const [url, options] = fetch.mock.calls[0]!
    expect(url).toBe('/api/v2/work-items')
    expect(options).toMatchObject({ method: 'POST', signal, body, cache: 'no-store', redirect: 'error' })
    expect(Object.fromEntries(new Headers(options.headers))).toMatchObject({ authorization: 'Bearer session-canary', 'content-type': 'application/json' })
  })
  it('旧请求的 401 不清除新令牌', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
    const pending = requestV2('/work-items')
    setToken('another')
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(readToken()).toBe('another')
  })
  it('服务返回 HTML 时报告错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html/>')))
    await expect(requestJson('/flows')).rejects.toThrow('非 JSON')
  })
  it('v2 的 204 视为无内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(requestV2('/work-items/i', { method: 'DELETE' })).resolves.toBeUndefined()
  })
})
