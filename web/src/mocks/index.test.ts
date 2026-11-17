import { afterEach, expect, it, vi } from 'vitest'
import type { Role } from '@/shared/api/types'

const { setApiTransport } = vi.hoisted(() => ({ setApiTransport: vi.fn<(transport: typeof fetch) => void>() }))
vi.mock('@/shared/http/client', () => ({ setApiTransport }))
import { startMockApi, STORAGE_KEY } from './index'

afterEach(() => {
  vi.useRealTimers()
  localStorage.removeItem(STORAGE_KEY)
  setApiTransport.mockClear()
})

it('浏览器入口注入独立 transport，使用 localStorage 且保留全局 fetch', async () => {
  vi.useFakeTimers()
  const nativeFetch = globalThis.fetch
  startMockApi()
  expect(setApiTransport).toHaveBeenCalledTimes(1)
  expect(globalThis.fetch).toBe(nativeFetch)
  expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
  const transport = setApiTransport.mock.calls[0]![0]
  const pending = transport('/api/roles')
  await vi.advanceTimersByTimeAsync(180)
  const roles = await (await pending).json() as Role[]
  expect(roles).toHaveLength(4)
  expect(roles[0]?.name).toBe('产品分析师')
})
