import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import { directory } from './api'

beforeEach(() => setToken('patch-test'))
afterEach(() => { setToken(''); vi.unstubAllGlobals() })

it('路径是包内相对路径参数，文件内容不做文本转换', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === 'PUT'
    ? new Response(null, { status: 204 })
    : new Response(new Uint8Array([255, 0]), { headers: { 'Content-Type': 'application/octet-stream' } }))
  vi.stubGlobal('fetch', fetch)
  const dir = directory('work', 'pack')
  const path = '项目/#&!= x.bin'
  const bytes = await dir.read(path)
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(bytes)
  })
  expect(new Uint8Array(buffer)).toEqual(new Uint8Array([255, 0]))
  await dir.write(path, bytes, true)
  const [url, init] = fetch.mock.calls[1]!
  const result = new URL(url, 'http://localhost')
  expect(result.pathname).toBe('/api/v2/patches/work/pack/file')
  expect(result.searchParams.get('path')).toBe(path)
  expect(result.searchParams.get('replace')).toBe('true')
  expect(init.body).toBe(bytes)
})

it('空文件可读，非文件响应不能进入编辑器', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { headers: { 'Content-Type': 'application/octet-stream' } }))
    .mockResolvedValueOnce(new Response('<html>代理页面</html>', { headers: { 'Content-Type': 'text/html' } })))
  const dir = directory('config', 'one')
  expect((await dir.read('AGENTS.md')).size).toBe(0)
  await expect(dir.read('mcp.json')).rejects.toThrow('未返回文件')
})
