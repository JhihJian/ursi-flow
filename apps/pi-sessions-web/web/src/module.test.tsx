// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceProvider, useWorkspace } from '@ursi/workspace-shell'
import type { Listing, Prefs, ServerConfig, SessionRow } from './api'
import { PI_SESSION_KIND, createPiSessionsModule } from './module'

/**
 * 模块接入契约测试：工厂产物、选中映射、折叠态文案、跨模块命令的校验。
 * 外壳用真正的 WorkspaceProvider，其余用内存假服务，不连后端。
 */

const CONFIG: ServerConfig = {
  defaultRoot: '/sessions',
  suggestedRoots: ['/sessions'],
  maxTextBytes: 1024,
}
const PREFS: Prefs = { pinnedProjects: [] }

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: '01a20000-0000-7000-8000-000000000001',
  path: '/sessions/proj-a/one.jsonl',
  projectDir: 'proj-a',
  projectKey: '/demo/alpha',
  projectName: 'alpha',
  cwd: '/demo/alpha',
  firstMessage: '第一条用户消息',
  messageCount: 3,
  created: Date.now(),
  modified: Date.now(),
  size: 2048,
  format: 'pi',
  detailsPending: false,
  ...over,
})

const LISTING: Listing = {
  root: '/sessions',
  sessions: [row()],
  pendingDetails: 0,
  truncated: false,
}

interface FakeServer {
  listing: (root: string) => Listing
  /** 抛错的根目录，用来验证命令的校验。 */
  brokenRoots?: string[]
  calls: string[]
}

let server: FakeServer

beforeEach(() => {
  server = { listing: () => LISTING, calls: [] }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    server.calls.push(url)
    const parsed = new URL(url, 'http://localhost')
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    if (parsed.pathname === '/api/config') return json(CONFIG)
    if (parsed.pathname === '/api/prefs') return json(PREFS)
    if (parsed.pathname === '/api/browse') {
      const path = parsed.searchParams.get('path') ?? ''
      if (server.brokenRoots?.includes(path)) {
        return new Response(JSON.stringify({ error: `目录不存在: ${path}` }), { status: 400 })
      }
      return json({ path, parent: '/', dirs: [] })
    }
    if (parsed.pathname === '/api/sessions') {
      const root = parsed.searchParams.get('root') ?? ''
      if (server.brokenRoots?.includes(root)) {
        return new Response(JSON.stringify({ error: `目录不存在: ${root}` }), { status: 400 })
      }
      return json(server.listing(root))
    }
    return new Response(JSON.stringify({ error: `未预期的请求 ${url}` }), { status: 404 })
  }) as typeof fetch
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(element)
  })
  // 配置与列表各一次异步请求，多刷一轮微任务让两轮都落地。
  await act(async () => {
    await Promise.resolve()
  })
}

describe('工厂产物', () => {
  test('id 与 context.kind 固定，侧边栏与工作区都在', () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api' })
    expect(mod.id).toBe('pi-sessions')
    expect(mod.context.kind).toBe('pi.session')
    expect(PI_SESSION_KIND).toBe('pi.session')
    expect(typeof mod.Sidebar).toBe('function')
    expect(typeof mod.Workspace).toBe('function')
    expect(typeof mod.Provider).toBe('function')
    // 轨迹由工作区自己懒加载，模块本身不保活
    expect(mod.keepMounted).toBe(false)
    expect(typeof mod.commands.openRoot).toBe('function')
  })

  test('apiBaseUrl 注入后请求带上该前缀', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api/pi-sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    await render(
      <Provider>
        <Sidebar collapsed={false} collapse={() => {}} expand={() => {}} />
      </Provider>,
    )
    expect(server.calls.some((url) => url.startsWith('/api/pi-sessions/config'))).toBe(true)
  })
})

describe('侧边栏', () => {
  test('折叠态窄条给出会话数与项目数', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    await render(
      <Provider>
        <Sidebar collapsed collapse={() => {}} expand={() => {}} />
      </Provider>,
    )
    const rail = container.querySelector('.ws-section-rail')
    expect(rail).not.toBeNull()
    expect(rail!.getAttribute('aria-label')).toContain('展开 Sessions')
    expect(rail!.textContent).toContain('1')
    expect(container.textContent).not.toContain('特别关注')
  })

  test('展开态列出会话，点选后发布 pi.session 选中给外壳', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    // 外壳的 WorkspaceProvider 在模块之外，选中由模块内的 SelectionBridge 发布出来。
    await render(
      <WorkspaceProvider>
        <Provider>
          <Sidebar collapsed={false} collapse={() => {}} expand={() => {}} />
          <SelectionProbe />
        </Provider>
      </WorkspaceProvider>,
    )
    const items = [...container.querySelectorAll('.session-item')]
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].textContent).toContain('第一条用户消息')

    await act(async () => {
      ;(items[0] as HTMLButtonElement).click()
    })
    const probe = container.querySelector('[data-testid="selection"]')
    expect(probe?.textContent).toBe(`pi.session:${row().id}`)
  })
})

/** 只读探针：把外壳里发布的选中取出来，用来验证选中映射。 */
function SelectionProbe() {
  const { selection } = useWorkspace()
  return (
    <span data-testid="selection">{selection ? `${selection.kind}:${selection.id}` : 'none'}</span>
  )
}

describe('跨模块命令', () => {
  test('目录不可读时抛错且不切换根目录', async () => {
    server.brokenRoots = ['/nope']
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    await render(
      <Provider>
        <Sidebar collapsed={false} collapse={() => {}} expand={() => {}} />
      </Provider>,
    )
    await expect(mod.commands.openRoot('/nope')).rejects.toThrow('目录不存在')
  })

  test('模块未挂载时命令直接报错，不发请求', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    await expect(mod.commands.openRoot('/sessions')).rejects.toThrow('未挂载')
    // 未挂载时不该有 sessions 请求（配置/偏好由 Provider 拉，这里没有 Provider）
    expect(server.calls.filter((url) => url.includes('/sessions'))).toHaveLength(0)
  })

  test('挂载后切换到新根目录，返回普通值', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    await render(
      <Provider>
        <Sidebar collapsed={false} collapse={() => {}} expand={() => {}} />
      </Provider>,
    )
    let result: { id: string; label: string } | null = null
    await act(async () => {
      result = await mod.commands.openRoot('/sessions/other')
    })
    // label 走 shortRoot：两段以内原样返回
    expect(result).toEqual({ id: '/sessions/other', label: '/sessions/other' })
    // 换根前的校验走目录浏览接口，不是整目录扫描
    expect(server.calls.some((url) => url.includes('/api/browse?path=%2Fsessions%2Fother'))).toBe(true)
  })

  test('空目录名被拒绝', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api' })
    await expect(mod.commands.openRoot('   ')).rejects.toThrow('目录不能为空')
  })
})

describe('选中同步', () => {
  test('模块挂载时不清掉别的模块的选中', async () => {
    const mod = createPiSessionsModule({ apiBaseUrl: '/api', initialRoot: '/sessions' })
    const Provider = mod.Provider!
    const Sidebar = mod.Sidebar
    // 先由别的模块占住选中，再挂载会话模块：没有选中会话时不能把它清空。
    function SeedOther() {
      const { select } = useWorkspace()
      useEffect(() => {
        select({ kind: 'todo.task', id: 'task-1', label: '别的模块' })
      }, [select])
      return null
    }
    await render(
      <WorkspaceProvider>
        <SeedOther />
        <Provider>
          <Sidebar collapsed={false} collapse={() => {}} expand={() => {}} />
          <SelectionProbe />
        </Provider>
      </WorkspaceProvider>,
    )
    expect(container.querySelector('[data-testid="selection"]')?.textContent).toBe('todo.task:task-1')
  })
})
