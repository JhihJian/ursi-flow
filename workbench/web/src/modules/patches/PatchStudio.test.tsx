import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { setToken } from '@/shared/http/session'
import { patchRoutes } from './routes'

const seen = vi.hoisted(() => ({ dirs: [] as unknown[] }))

vi.mock('./Explorer', () => ({
  Explorer: ({ directory }: { directory: unknown }) => {
    seen.dirs.push(directory)
    return <div data-testid="explorer" />
  },
}))

vi.mock('./ConfigEditor', () => ({
  ConfigEditor: ({ directory }: { directory: unknown }) => {
    seen.dirs.push(directory)
    return <div data-testid="config-editor" />
  },
}))

type Serve = (path: string, options: RequestInit) => Response | Promise<Response>
type Call = { path: string; options: RequestInit }

function mount(path: string, serve: Serve) {
  setToken('demo')
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const clean = String(input).replace('/api/v2', '')
    calls.push({ path: clean, options })
    return serve(clean, options)
  }))
  const router = createMemoryRouter(patchRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return { router, calls }
}

const workPackages = [
  { id: 'w1', name: '交付整理' },
  { id: 'w2', name: '回归排查' },
]
const configPackages = [
  { id: 'c1', name: '审核助手' },
  { id: 'c2', name: '发布助手' },
]

function packages(kind: 'work' | 'config') {
  return (path: string) => path === `/patches/${kind}`
    ? Response.json(kind === 'work' ? workPackages : configPackages)
    : Response.json({ error: `意外请求 ${path}` }, { status: 500 })
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  seen.dirs.length = 0
})

describe('包编辑台框架', () => {
  it('工作包详情直接打开 Explorer，名称栏切换走路由并用新目录重挂载', async () => {
    const user = userEvent.setup()
    const { router } = mount('/work-patches/w1', packages('work'))

    expect(await screen.findByTestId('patch-studio')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '交付整理' })).toBeInTheDocument()
    expect(screen.getByTestId('explorer')).toBeInTheDocument()
    expect(screen.queryByTestId('config-editor')).toBeNull()

    const before = seen.dirs.at(-1)
    // 浮层开合只重渲染框架，目录对象必须保持同一引用。
    await user.click(screen.getByTestId('patch-switcher-trigger'))
    expect(await screen.findByTestId('patch-switcher-panel')).toBeInTheDocument()
    await user.click(screen.getByTestId('patch-switcher-trigger'))
    expect(seen.dirs.at(-1)).toBe(before)

    await user.click(screen.getByTestId('patch-switcher-trigger'))
    const panel = await screen.findByTestId('patch-switcher-panel')
    await user.click(within(panel).getByRole('button', { name: /回归排查/ }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/work-patches/w2') })
    expect(await screen.findByRole('button', { name: '回归排查' })).toBeInTheDocument()
    expect(seen.dirs.at(-1)).not.toBe(before)
  })

  it('窄屏切换按钮用抽屉选出另一个工作包', async () => {
    const user = userEvent.setup()
    const { router } = mount('/work-patches/w1', packages('work'))

    await screen.findByRole('button', { name: '交付整理' })
    await user.click(screen.getByTestId('patch-switch'))
    const sheet = await screen.findByRole('dialog', { name: '切换包' })
    await user.click(within(sheet).getByRole('button', { name: /回归排查/ }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/work-patches/w2') })
  })

  it('配置包详情使用 ConfigEditor，并同样支持换包', async () => {
    const user = userEvent.setup()
    const { router } = mount('/config-patches/c1', packages('config'))

    expect(await screen.findByTestId('config-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('explorer')).toBeNull()
    expect(await screen.findByRole('button', { name: '审核助手' })).toBeInTheDocument()

    const before = seen.dirs.at(-1)
    await user.click(screen.getByTestId('patch-switcher-trigger'))
    const panel = await screen.findByTestId('patch-switcher-panel')
    await user.click(within(panel).getByRole('button', { name: /发布助手/ }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/config-patches/c2') })
    expect(await screen.findByRole('button', { name: '发布助手' })).toBeInTheDocument()
    expect(seen.dirs.at(-1)).not.toBe(before)
  })

  it('列表创建只填名称，创建成功后进入新包的编辑台', async () => {
    const user = userEvent.setup()
    const { router, calls } = mount('/work-patches', (path, options) => {
      if (path !== '/patches/work') return Response.json({ error: `意外请求 ${path}` }, { status: 500 })
      if (options.method === 'POST') return Response.json({ id: 'w-new', name: '新包' })
      return Response.json([])
    })

    expect(await screen.findByText('暂无工作包')).toBeVisible()
    await user.click(screen.getAllByRole('button', { name: '新建工作包' })[0])
    const dialog = await screen.findByRole('dialog', { name: '新建工作包' })
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)

    await user.type(within(dialog).getByLabelText('名称'), '新包')
    await user.click(within(dialog).getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/work-patches/w-new') })

    const post = calls.find(call => call.path === '/patches/work' && call.options.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post!.options.body))).toEqual({ name: '新包' })
  })

  it('导出两类包的列表与详情路由', () => {
    expect(patchRoutes.map(route => route.path)).toEqual([
      '/work-patches',
      '/work-patches/:id',
      '/config-patches',
      '/config-patches/:id',
    ])
  })
})
