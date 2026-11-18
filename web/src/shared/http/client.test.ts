import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from './client'
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
  it('无令牌不发请求，拒绝绝对地址', async () => {
    vi.stubGlobal('fetch', vi.fn()); setToken('')
    await expect(requestJson('/flows')).rejects.toMatchObject({ status: 401 })
    await expect(requestJson('https://invalid.test')).rejects.toThrow(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('401 清除失效会话，错误消息不回显令牌', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'session-canary' }, { status: 401 })))
    await expect(requestJson('/flows')).rejects.toThrow('HTTP 401：[已隐藏]')
    expect(readToken()).toBe('')
  })
  it('服务返回 HTML 时报告错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html/>')))
    await expect(requestJson('/flows')).rejects.toThrow('非 JSON')
  })
})
