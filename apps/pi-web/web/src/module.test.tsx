// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceProvider } from '@ursi/workspace-shell'
import { createPiModule } from './module'
import { useSessionsController } from './views/sessions/sessions-context'

/**
 * 模块装配测试：一个侧栏、三种页面、一份 home。
 *
 * 只验证装配（不测各页面内部的业务），因为它覆盖的是最容易出错的地方：
 * Provider 嵌套顺序、home 真源、侧栏合一、新对话的目录来自侧栏点选。
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
    if (path === '/api/homes/defaults') return respond({ default: HOME.path, discovered: [HOME] })
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
    if (path === '/api/config/general') {
      return respond({
        revision: 'r1',
        managed: { defaultTools: [], codemode: null, showCacheMissNotices: null },
        unmanagedKeys: [],
        builtinTools: [],
        builtinToolNames: [],
        resolvedTools: [],
        isWindows: false,
        powerShellEnabled: null,
      })
    }
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
function Inner({ collapsed }: { collapsed: boolean }) {
  const Provider = MODULE.Provider
  const body = (
    <>
      <MODULE.Sidebar collapsed={collapsed} collapse={() => undefined} expand={() => undefined} />
      <MODULE.Workspace />
    </>
  )
  return Provider ? <Provider>{body}</Provider> : body
}

function Harness({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <WorkspaceProvider>
      <Inner collapsed={collapsed} />
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
  test('一个侧栏：home 清单、目录行、会话列表、底部新对话与配置', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain('Pi home')
    expect(container.querySelector('.root-button')?.textContent).toContain('pi-home/sessions')
    expect(container.querySelector('.session-list')).not.toBeNull()
    const foot = container.querySelector('.pi-sidebar-foot')
    expect(foot?.textContent).toContain('新对话')
    expect(foot?.textContent).toContain('配置')
    // 三段切换不再存在。
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })

  test('工作区默认是新对话页，点配置进配置页，返回回到新对话', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    await settle()
    expect(container.querySelector('.pichat-bar-title')?.textContent).toBe('新对话')

    const configButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('配置'))
    expect(configButton).toBeDefined()
    await act(async () => configButton!.click())
    await settle()
    await settle()
    expect(container.querySelector('.pi-config-page')).not.toBeNull()
    expect(container.querySelector('.pi-config-page')?.closest('[hidden]')).toBeNull()

    const back = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('返回'))
    await act(async () => back!.click())
    await settle()
    expect(container.querySelector('.pi-workspace-page:not([hidden]) .pichat-bar-title')?.textContent).toBe('新对话')
  })

  test('折叠态只留一条可点击窄条，带 home 名', async () => {
    await act(async () => root.render(<Harness collapsed />))
    await settle()
    await settle()
    const rail = container.querySelector('.ws-section-rail') as HTMLElement
    expect(rail).not.toBeNull()
    expect(rail.textContent).toContain('Pi')
    expect(rail.getAttribute('aria-label')).toContain('默认')
    expect(container.querySelector('.pi-sidebar')).toBeNull()
  })

  test('home 记忆写在同一个前缀下', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    await settle()
    expect(localStorage.getItem('pi-manager.home')).toBe(HOME.path)
  })
})

describe('会话根目录跟随 home', () => {
  /** 在 Provider 内读会话根并写进 DOM，不改产品代码。 */
  function RootProbe() {
    const { root, setRoot } = useSessionsController()
    return (
      <>
        <span data-testid="root">{root ?? 'none'}</span>
        <button type="button" data-testid="pick" onClick={() => setRoot('/elsewhere')}>
          选外部目录
        </button>
      </>
    )
  }

  test('用户选了外部目录后，home 没变就不会被拉回 sessionsRoot', async () => {
    const Provider = MODULE.Provider!
    await act(async () => {
      root.render(
        <WorkspaceProvider>
          <Provider>
            <RootProbe />
          </Provider>
        </WorkspaceProvider>,
      )
    })
    await settle()
    expect(container.querySelector('[data-testid="root"]')?.textContent).toBe(HOME.sessionsRoot)

    const pick = container.querySelector('[data-testid="pick"]') as HTMLButtonElement
    await act(async () => pick.click())
    // 多走几轮 effect：以前 SessionsBridge 的依赖里有 root，这里会被拉回去。
    await settle()
    await settle()
    expect(container.querySelector('[data-testid="root"]')?.textContent).toBe('/elsewhere')
  })
})
