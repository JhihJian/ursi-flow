import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestJson, requestV2, requestV2Text } from './client'
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
  it.each([requestJson, requestV2, requestV2Text])('无令牌不发请求，拒绝绝对地址', async request => {
    vi.stubGlobal('fetch', vi.fn()); setToken('')
    await expect(request('/items')).rejects.toMatchObject({ status: 401 })
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
    const body = JSON.stringify({ assignee: 'Lin' })
    await expect(requestV2('/items/item-1/start', { method: 'POST', signal, body })).resolves.toEqual({ id: 'item-1' })
    const [url, options] = fetch.mock.calls[0]!
    expect(url).toBe('/api/v2/items/item-1/start')
    expect(options).toMatchObject({ method: 'POST', signal, body, cache: 'no-store', redirect: 'error' })
    expect(Object.fromEntries(new Headers(options.headers))).toMatchObject({ authorization: 'Bearer session-canary', 'content-type': 'application/json' })
  })
  it('v2 文本返回原始交付正文，错误使用共享的 HTTP 状态和脱敏规则', async () => {
    const text = '第一行\n第二行\n'
    const fetch = vi.fn().mockResolvedValueOnce(new Response(text)).mockResolvedValueOnce(Response.json({ error: { message: 'session-canary' } }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const path = '/items/i/deliveries/1/files/report.txt'
    await expect(requestV2Text(path)).resolves.toBe(text)
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v2${path}`)
    expect(fetch.mock.calls[0]![1].headers.get('Accept')).toBe('text/plain')
    await expect(requestV2Text(path)).rejects.toMatchObject({ status: 409, message: 'HTTP 409：[已隐藏]' })
    expect(readToken()).toBe('session-canary')
  })
  it('旧请求的 401 不清除新令牌', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })))
    const pending = requestV2Text('/file')
    setToken('another')
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(readToken()).toBe('another')
  })
  it('当前令牌自己的 401 仍清除会话', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 401 })))
    await expect(requestV2Text('/file')).rejects.toMatchObject({ status: 401 })
    expect(readToken()).toBe('')
  })
  it('服务返回 HTML 时报告错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html/>')))
    await expect(requestJson('/flows')).rejects.toThrow('非 JSON')
  })
  it('v2 的 204 视为无内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(requestV2('/items/i/cancel')).resolves.toBeUndefined()
  })
})

describe('交付纯文本读取', () => {
  const path = '/items/i/deliveries/1/files/report.txt'
  const stub = (response: Response) => { const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetch); return fetch }

  it('只有 text/plain 正文算读取成功，保留换行与空白', async () => {
    const text = '第一行\n  第二行\n'
    stub(new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    await expect(requestV2Text(path)).resolves.toBe(text)
  })

  it('200 text/html 报告读取失败，不把代理首页当交付', async () => {
    stub(new Response('<!doctype html><html><body>Vite</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    await expect(requestV2Text(path)).rejects.toMatchObject({ status: 200, message: 'HTTP 200：交付文件必须是纯文本，服务返回了 text/html。' })
  })

  it('204 报告读取失败', async () => {
    stub(new Response(null, { status: 204 }))
    await expect(requestV2Text(path)).rejects.toMatchObject({ status: 204, message: 'HTTP 204：交付文件为空，无法读取。' })
  })

  it.each(['', '  \n\t '])('空正文 %j 报告读取失败', async body => {
    stub(new Response(body, { headers: { 'content-type': 'text/plain' } }))
    await expect(requestV2Text(path)).rejects.toMatchObject({ status: 200 })
  })
})
