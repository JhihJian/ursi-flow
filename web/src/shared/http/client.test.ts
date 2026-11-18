import { describe, expect, it, vi } from 'vitest'
import { ApiError, apiErrorFromResponse, apiErrorMessage, getApiTransport, requestJson, setApiTransport } from './client'

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

  it('暴露当前注入的 transport 供响应流直接复用', () => {
    const transport = vi.fn() as unknown as typeof fetch
    setApiTransport(transport)
    expect(getApiTransport()).toBe(transport)
  })
})

describe('错误码文案映射', () => {
  it('白名单错误码给出对应文案并保留状态码', () => {
    expect(apiErrorFromResponse(503, 'SERVICE_UNAVAILABLE')).toMatchObject({
      name: 'ApiError', status: 503, message: '服务暂时不可用，请重试。',
    })
    expect(apiErrorFromResponse(404, 'NOT_FOUND')).toMatchObject({ status: 404, message: '请求的记录不存在或已被删除。' })
    expect(apiErrorFromResponse(409, 'REFERENCE_CONFLICT').message).toBe('此资源仍被其他配置引用，请先解除引用后再删除。')
    expect(apiErrorFromResponse(422, 'INVALID_WORKFLOW').message).toBe('流程定义不合法，请检查节点、连线和角色引用。')
  })

  it('未知或缺失错误码使用通用文案', () => {
    expect(apiErrorMessage()).toBe('请求失败，请稍后重试。')
    expect(apiErrorMessage('')).toBe('请求失败，请稍后重试。')
    expect(apiErrorMessage('SOMETHING_NEW')).toBe('请求失败，请稍后重试。')
    expect(apiErrorMessage('__proto__')).toBe('请求失败，请稍后重试。')
    expect(apiErrorFromResponse(500, 'SOMETHING_NEW')).toBeInstanceOf(ApiError)
    expect(apiErrorFromResponse(500, 'SOMETHING_NEW').message).toBe('请求失败，请稍后重试。')
  })

  it('普通请求失败时沿用同一映射', async () => {
    setApiTransport((...args) => globalThis.fetch(...args))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })))
    await expect(requestJson('/roles/missing')).rejects.toMatchObject({ status: 404, message: '请求的记录不存在或已被删除。' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'UNKNOWN', message: '原始服务端文案' } }, { status: 400 })))
    const error = await requestJson('/roles').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ status: 400, message: '请求失败，请稍后重试。' })
    expect(String(error)).not.toContain('原始服务端文案')
  })
})
