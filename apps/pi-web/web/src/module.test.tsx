// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceProvider } from '@ursi/workspace-shell'
import { createPiModule } from './module'
import { useSessionsController } from './views/sessions/sessions-context'

/**
 * 模块装配测试：一个侧栏、一个会话页、一个配置页、一份 home。
 *
 * 只验证装配（不测各页面内部的业务），因为它覆盖的是最容易出错的地方：
 * Provider 嵌套顺序、home 真源、侧栏合一、会话入口与路由键唯一。
 */

/** 近期时间：默认只看今天，行要落在今天才不被日期筛掉。 */
const NOW = Date.now() - 60_000

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

/** 侧栏里的一条会话：有 id、有文件、有 cwd。 */
const SESSION = {
  id: 'sess-1',
  state: 'discovered',
  kind: 'chat',
  filePath: '/tmp/pi-home/sessions/sess-1.jsonl',
  cwd: '/tmp/proj',
  title: '修一个 bug',
  persistence: 'file',
  seenAt: 1,
  origin: { kind: 'home', homeId: HOME.id, homePath: HOME.path },
  disk: {
    size: 10,
    mtime: 1,
    format: 'pi',
    messageCount: 0,
    firstMessage: '',
    createdAt: 1,
    updatedAt: NOW,
    projectKey: '/tmp/proj',
    projectName: 'proj',
    projectDir: '/tmp/proj',
  },
  runtimes: [],
}

/** jsdom 没有 EventSource：给一个只够 ChatProvider 挂回调的桩。 */
class EventSourceStub {
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    // 服务端首帧：ChatProvider 等它握上手才发首条消息。
    esOpened.push(url)
    setTimeout(() => {
      esFrames.push(this.onmessage ? 'sent' : 'no-handler')
      this.onmessage?.({ data: JSON.stringify({ type: 'state' }) })
    }, 0)
  }
  close() {}
}
let esOpened: string[] = []
let esFrames: string[] = []
/** 续聊成功过的会话 id：此后 state=live 的清单里有它。 */
let assembled: string[] = []

let posts: Array<{ path: string; body: Record<string, unknown> }> = []

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let calls: string[] = []

beforeEach(() => {
  calls = []
  posts = []
  esOpened = []
  esFrames = []
  assembled = []
  localStorage.clear()
  ;(globalThis as { EventSource?: unknown }).EventSource = EventSourceStub
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const parsed = new URL(url, 'http://localhost')
    const path = parsed.pathname.replace(/^\/api\/pi/, '')
    const method = init?.method ?? 'GET'
    if (method === 'POST' && path === '/api/sessions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push({ path, body })
      if (body.sessionId) {
        assembled.push(String(body.sessionId))
        return respond({ session: { ...SESSION, state: 'ready', runtimes: [{ origin: 'local', status: 'idle', host: '', pid: 1, updatedAt: 1 }] }, chat: chatOf(SESSION, 'ready') })
      }
      const created = { ...SESSION, id: 'sess-new', filePath: null, title: null, persistence: 'memory', cwd: String(body.cwd) }
      return respond({ session: created, chat: chatOf(created, 'idle') })
    }
    if (method === 'POST' && /\/api\/sessions\/[^/]+\/turn$/.test(path)) {
      posts.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return respond({ disposition: 'started' })
    }
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
      // 本进程装配过的（state=live）与磁盘清单分开回：侧栏的「释放运行时」按前者决定可用。
      const live = parsed.searchParams.get('state') === 'live'
      return respond({
        epoch: 'e',
        revision: 1,
        sessions: live ? assembled : [SESSION],
        pendingDetails: 0,
        truncated: false,
        heartbeatDetected: false,
      })
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

/** ChatProvider 眼里的会话运行时：实体投影。 */
function chatOf(entity: Omit<typeof SESSION, 'filePath' | 'title'> & { filePath: string | null; title: string | null }, state: string) {
  return {
    sessionId: entity.id,
    home: HOME.path,
    cwd: entity.cwd,
    model: null,
    thinkingLevel: null,
    sessionFile: entity.filePath,
    name: entity.title,
    state,
    isStreaming: false,
    partial: '',
    partialThinking: '',
    pendingCount: 0,
    error: null,
    startedAt: 1,
    updatedAt: 1,
  }
}

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

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise((done) => setTimeout(done, ms))
  })
}

/** 等到页面真正挂载：SessionThread 是 lazy 的，首次要一轮微任务。 */
async function waitFor(predicate: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) await settle(5)
  expect(predicate()).toBe(true)
}

/** 项目组默认折叠：点箭头展开后取第一条会话行。 */
async function expandAndPick(): Promise<HTMLElement> {
  const caret = container.querySelector('.session-group-caret') as HTMLElement
  await act(async () => caret.click())
  await settle()
  const item = container.querySelector('.session-item') as HTMLElement
  expect(item).not.toBeNull()
  return item
}

/** React 受控 textarea 要走原生 setter 再派发 input 事件，直接改 value 不会触发 onChange。 */
function nativeSetValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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

  test('工作区默认是空会话页，点配置进配置页，返回回到空会话页', async () => {
    await act(async () => root.render(<Harness />))
    await waitFor(() => container.querySelector('.pichat-bar-title') !== null)
    expect(container.querySelector('.pichat-bar-title')?.textContent).toBe('新对话')

    const configButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('配置'))
    expect(configButton).toBeDefined()
    await act(async () => configButton!.click())
    await waitFor(() => container.querySelector('.pi-config-page') !== null)
    expect(container.querySelector('.pi-config-page')?.closest('[hidden]')).toBeNull()

    const back = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('返回'))
    await act(async () => back!.click())
    await settle()
    expect(container.querySelector('.pi-workspace-page:not([hidden]) .pichat-bar-title')?.textContent).toBe('新对话')
  })

  test('会话页只有一个入口：右键菜单没有「打开」，点行就进', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    await settle()
    const item = await expandAndPick()
    await act(async () => item.click())
    await settle()
    expect(container.querySelector('.pichat-bar-title')?.textContent).toBe('修一个 bug')
    expect(container.querySelector('.session-item.is-active'), container.querySelector('.session-item')?.className).not.toBeNull()

    await act(async () =>
      item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })),
    )
    await settle()
    const menuText = container.querySelector('.sb-menu')?.textContent ?? container.textContent ?? ''
    expect(menuText).not.toContain('打开')
    expect(menuText).toContain('释放运行时')
    // 没有本进程运行时：释放项禁用。
    const evict = [...container.querySelectorAll('.sb-menu-item')].find((b) => b.textContent?.includes('释放运行时'))
    expect(evict?.hasAttribute('disabled')).toBe(true)
  })

  test('空会话页发首条消息：原地建会话，页面不换、输入框不重挂，续聊只传 sessionId', async () => {
    await act(async () => root.render(<Harness />))
    await settle()
    await settle()
    // 点组头把目录设为当前目录。
    const groupHead = container.querySelector('.session-group-name') as HTMLElement
    await act(async () => groupHead.click())
    await settle()

    const textarea = container.querySelector('.pichat-textarea') as HTMLTextAreaElement
    const composer = container.querySelector('.pichat-composer')
    expect(textarea).not.toBeNull()
    await act(async () => {
      nativeSetValue(textarea, '你好')
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle(80)
    await settle()

    expect(posts, JSON.stringify({ posts, esOpened, esFrames, title: container.querySelector('.pichat-bar-title')?.textContent })).toHaveLength(2)
    expect(posts[0]?.body).toMatchObject({ home: HOME.path, cwd: '/tmp/proj' })
    expect(posts[0]?.body).not.toHaveProperty('sessionId')
    expect(posts[1]?.path).toBe('/api/sessions/sess-new/turn')
    // 页面没换：还是同一个输入框 DOM 节点，标题已经从「新对话」变成会话。
    expect(container.querySelector('.pichat-composer')).toBe(composer)
    expect(container.querySelector('.pichat-bar-title')?.textContent).not.toBe('新对话')
    expect(container.querySelector('.session-item.is-active')).toBeNull()

    // 回到空会话页再点已有会话：发消息走续聊，只传 sessionId、不传 home。
    const newChat = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('新对话'))!
    await act(async () => newChat.click())
    await settle()
    await waitFor(() => container.querySelector('.pichat-bar-title')?.textContent === '新对话')
    // 点「+ 新对话」只回空会话页：侧栏高亮清掉，组按默认规则收起。
    const item = await expandAndPick()
    await act(async () => item.click())
    await settle()
    posts = []
    const again = container.querySelector('.pichat-textarea') as HTMLTextAreaElement
    await act(async () => {
      nativeSetValue(again, '继续')
      again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle(80)
    await settle()
    expect(posts[0]?.body).toEqual({ sessionId: SESSION.id })
    expect(posts[1]?.path).toBe(`/api/sessions/${SESSION.id}/turn`)
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
