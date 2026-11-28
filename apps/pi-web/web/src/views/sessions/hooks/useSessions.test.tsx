// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Listing, SessionsApi } from '../api'
import { useSessions } from './useSessions'

/**
 * 列表轮询：后台刷新带版本号，服务端说没变就沿用上一份列表；
 * 补明细的轮询一轮轮往后退，不会一直按固定间隔重拉。
 */

const listing = (revision: number, pendingDetails = 0): Listing => ({
  root: '/sessions',
  sessions: [],
  pendingDetails,
  truncated: false,
  revision,
  heartbeatDetected: false,
})

let api: SessionsApi
let calls: Array<{ since: number | undefined }>
/** 按 since 决定回什么：undefined 是整份拉，否则由 respond 给出；抛出即模拟失败。 */
let respond: (since: number | undefined) => Listing | null

beforeEach(() => {
  calls = []
  respond = () => null
  api = {
    baseUrl: '',
    fetchConfig: () => Promise.reject(new Error('不用')),
    fetchSessions: (_root, since) => {
      calls.push({ since })
      try {
        return Promise.resolve(since === undefined ? listing(7, 3) : respond(since))
      } catch (failure) {
        return Promise.reject(failure)
      }
    },
    fetchDetail: () => Promise.reject(new Error('不用')),
    fetchBrowse: () => Promise.reject(new Error('不用')),
    sessionTextUrl: () => '',
    fetchPrefs: () => Promise.reject(new Error('不用')),
    updatePrefs: () => Promise.reject(new Error('不用')),
    deleteSession: () => Promise.reject(new Error('不用')),
    fetchSessionText: () => Promise.reject(new Error('不用')),
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function Probe({ api }: { api: SessionsApi }) {
  const state = useSessions('/sessions', api)
  return (
    <span data-testid="state">
      {state.listing ? `${state.listing.revision}:${state.listing.pendingDetails}` : 'none'}|{String(state.loading)}|
      {state.error ?? '-'}
    </span>
  )
}

const text = () => container.querySelector('[data-testid="state"]')?.textContent

describe('useSessions', () => {
  test('首次整份拉取且不带版本号，随后补明细轮询带上版本号', async () => {
    await act(async () => root.render(<Probe api={api} />))
    expect(calls).toEqual([{ since: undefined }])
    expect(text()).toBe('7:3|false|-')

    respond = () => null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls[1]).toEqual({ since: 7 })
    // 没变就沿用上一份：版本号与待补数都还是 7:3
    expect(text()).toBe('7:3|false|-')
  })

  test('版本号变了就换成新列表', async () => {
    await act(async () => root.render(<Probe api={api} />))
    respond = () => listing(8, 0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(text()).toBe('8:0|false|-')
  })

  test('后台刷新失败不清空列表也不置 loading', async () => {
    await act(async () => root.render(<Probe api={api} />))
    expect(text()).toBe('7:3|false|-')
    // 首次拉成功后服务端挂掉：下一轮补明细刷新失败，界面保留上一份列表。
    respond = () => {
      throw new Error('网络抖动')
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ since: 7 })
    expect(text()).toBe('7:3|false|-')
  })

  test('首次拉取失败才清空列表并报错', async () => {
    await act(async () =>
      root.render(
        <Probe api={{ ...api, fetchSessions: () => Promise.reject(new Error('目录不可读')) }} />,
      ),
    )
    expect(text()).toBe('none|false|目录不可读')
  })

  test('补明细的间隔一轮轮往后退，不是固定 800ms', async () => {
    await act(async () => root.render(<Probe api={api} />))
    respond = () => listing(8, 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(calls).toHaveLength(2)
    // 第二轮要等 1600ms：再走 700ms 还没到，走满 1600ms 才发。
    respond = () => listing(9, 3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(calls).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900)
    })
    expect(calls).toHaveLength(3)
  })
})
