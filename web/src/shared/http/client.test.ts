import { describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from './client'

describe('公共请求入口', () => {
  it('保持响应结构并向同源 API 传递取消信号', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 'role-1' }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(requestJson('/roles/role-1', { signal: controller.signal })).resolves.toEqual({ id: 'role-1' })
    expect(fetchMock).toHaveBeenCalledWith('/api/roles/role-1', expect.objectContaining({
      signal: controller.signal, credentials: 'same-origin',
    }))
  })

  it('支持无内容响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(requestJson('/roles/role-1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('HTTP 错误不向用户传播原始响应中的凭据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-canary', { status: 502 })))
    const error = await requestJson('/connections').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502 })
    expect(String(error)).not.toContain('secret-canary')
  })

  it('拒绝把服务端回退 HTML 当作业务数据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>SPA</html>', {
      headers: { 'Content-Type': 'text/html' },
    })))
    await expect(requestJson('/roles')).rejects.toThrow('非 JSON')
  })

  it('无效 JSON 返回固定错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{secret-canary', {
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(requestJson('/roles')).rejects.toThrow('无法读取的数据')
  })

  it('保留调用方取消的错误身份', async () => {
    const aborted = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted))
    await expect(requestJson('/runs')).rejects.toBe(aborted)
  })

  it('读取响应体期间取消也保留 AbortError', async () => {
    const aborted = new DOMException('Aborted', 'AbortError')
    const response = Response.json({ id: 'run-1' })
    vi.spyOn(response, 'json').mockRejectedValue(aborted)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(requestJson('/runs')).rejects.toBe(aborted)
  })

  it('拒绝绝对 URL 且不发出请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestJson('https://example.org/roles')).rejects.toThrow(TypeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
