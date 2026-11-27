import { afterEach, expect, test } from 'vitest'
import { createSessionsApi } from './api'

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch
})

function entity(over: Record<string, unknown>) {
  return {
    id: '01a20000-0000-7000-8000-000000000001',
    state: 'ready',
    kind: 'chat',
    filePath: null,
    cwd: '/demo/alpha',
    title: null,
    persistence: 'memory',
    seenAt: Date.parse('2026-01-05T10:00:00.000Z'),
    origin: { kind: 'home', homeId: 'h', homePath: '/home' },
    disk: null,
    runtimes: [{ origin: 'local', status: 'idle', host: 'x', pid: 1, updatedAt: 1 }],
    ...over,
  }
}

test('还没落盘的新会话按注册时刻算修改时间，不会被「只看今天」筛掉', async () => {
  const seenAt = Date.parse('2026-01-05T10:00:00.000Z')
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ epoch: 'e', revision: 1, sessions: [entity({ seenAt })], pendingDetails: 0, truncated: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

  const listing = await createSessionsApi('').fetchSessions('/home/sessions')
  expect(listing?.sessions).toHaveLength(1)
  expect(listing?.sessions[0].modified).toBe(seenAt)
  expect(listing?.sessions[0].created).toBe(seenAt)
})

test('落盘后以文件的修改时间为准，注册时刻只做兜底', async () => {
  const disk = {
    size: 2048,
    mtime: 1,
    format: 'pi',
    messageCount: 3,
    firstMessage: '你好',
    createdAt: 100,
    updatedAt: 200,
    projectKey: '/demo/alpha',
    projectName: 'alpha',
    projectDir: 'alpha',
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ epoch: 'e', revision: 1, sessions: [entity({ disk, seenAt: 50 })], pendingDetails: 0, truncated: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

  const listing = await createSessionsApi('').fetchSessions('/home/sessions')
  expect(listing?.sessions[0].modified).toBe(200)
  expect(listing?.sessions[0].created).toBe(100)
})
