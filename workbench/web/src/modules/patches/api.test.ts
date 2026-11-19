import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import { createPatch, listPatches } from './api'

beforeEach(() => setToken('patch-test'))
afterEach(() => { setToken(''); vi.unstubAllGlobals() })

it('列表与新建都走包记录接口，响应带目录标识', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json([{ id: 'w1', name: '交付整理', directoryId: 'd1' }]))
    .mockResolvedValueOnce(Response.json({ id: 'w2', name: '回归排查', directoryId: 'd2' }))
  vi.stubGlobal('fetch', fetch)

  expect(await listPatches('work')).toEqual([{ id: 'w1', name: '交付整理', directoryId: 'd1' }])
  expect(await createPatch('work', '回归排查')).toEqual({ id: 'w2', name: '回归排查', directoryId: 'd2' })

  const [listUrl, listInit] = fetch.mock.calls[0]!
  expect(new URL(listUrl, 'http://localhost').pathname).toBe('/api/v2/patches/work')
  expect(listInit.method ?? 'GET').toBe('GET')
  const [createUrl, createInit] = fetch.mock.calls[1]!
  expect(new URL(createUrl, 'http://localhost').pathname).toBe('/api/v2/patches/work')
  expect(createInit.method).toBe('POST')
  expect(JSON.parse(String(createInit.body))).toEqual({ name: '回归排查' })
})
