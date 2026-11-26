// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceProvider } from '@ursi/workspace-shell'
import { createPiModule } from './module'

/**
 * 合并模块的装配测试：一个模块、三个视图、一份 home。
 *
 * 只验证装配与切换（不测各视图内部的业务），因为它覆盖的是最容易在合并时
 * 出错的地方：Provider 嵌套顺序、home 真源、视图激活后才挂载。
 */

const HOME = {
  id: 'home-1',
  name: '默认',
  path: '/tmp/pi-home',
  listed: true,
  sources: ['default'],
  valid: true,
  sessionsRoot: '/tmp/pi-home/sessions',
  skills: 1,
  agents: 1,
  mcpServers: 0,
  packages: 0,
  hasModels: true,
  hasAuth: true,
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let calls: string[] = []

beforeEach(() => {
  calls = []
  localStorage.clear()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const parsed = new URL(url, 'http://localhost')
    const path = parsed.pathname.replace(/^\/api\/pi/, '')
    if (path === '/api/homes') return respond({ homes: [HOME] })
    if (path === '/api/homes/check') return respond({ home: HOME.path, valid: true })
    if (path === '/api/homes/runtime-profile') {
      return respond({
        homeId: HOME.id,
        revision: 1,
        models: {
          candidates: [],
          default: null,
          defaultThinkingLevel: null,
          isScoped: false,
          scopeWarnings: [],
          thinkingLevelPins: {},
        },
        subagents: [],
        cwdDefault: '/tmp',
        sessionsRoot: HOME.sessionsRoot,
        catalog: { fetchedAt: null },
      })
    }
    if (path === '/api/sessions/config') {
      return respond({ defaultRoot: HOME.sessionsRoot, suggestedRoots: [], maxTextBytes: 1_000_000 })
    }
    if (path === '/api/sessions') {
      return respond({ epoch: 'e', revision: 1, sessions: [], pendingDetails: 0, truncated: false })
    }
    if (path === '/api/sessions/prefs') return respond({ pinnedProjects: [] })
    return respond({})
  }) as typeof fetch
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const MODULE = createPiModule({ apiBaseUrl: '/api/pi', storageKey: 'test.pi' })

/** 外壳里挂载：Provider 只包内容，选中上下文来自 WorkspaceProvider。 */
function Inner() {
  const Provider = MODULE.Provider
  const body = (
    <>
      <MODULE.Sidebar collapsed={false} collapse={() => undefined} expand={() => undefined} />
      <MODULE.Workspace />
    </>
  )
  return Provider ? <Provider>{body}</Provider> : body
}

function Harness() {
  return (
    <WorkspaceProvider>
      <Inner />
    </WorkspaceProvider>
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise((done) => setTimeout(done, 0))
  })
}

describe('Pi Web 模块', () => {
  test('一个模块暴露三个视图的切换，默认进对话', async () => {
    await act(async () => root.render(<Harness />))
    await settle()

    const tabs = [...container.querySelectorAll('.pi-switch-tab')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['对话', '会话', '配置'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
  })

  test('切到会话视图才挂载它，切回不重建对话', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    expect(container.querySelector('[data-view="sessions"]')).toBeNull()

    const sessionsTab = [...container.querySelectorAll('.pi-switch-tab')][1] as HTMLElement
    await act(async () => sessionsTab.click())
    await settle()

    expect(container.querySelector('[data-view="sessions"]')).not.toBeNull()
    expect(sessionsTab.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-view="chat"]')).not.toBeNull()
  })

  test('home 与视图记忆写在同一个前缀下', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    const sessionsTab = [...container.querySelectorAll('.pi-switch-tab')][1] as HTMLElement
    await act(async () => sessionsTab.click())
    await settle()
    expect(localStorage.getItem('ursi.pi:view')).toBe('sessions')
    expect(localStorage.getItem('ursi.pi:home')).toBe(HOME.path)
  })
})
