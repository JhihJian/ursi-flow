import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import { workPatchGeneratorRoutes } from './routes'
import type { GenerationRun, Generator } from '@/shared/api/work-patch-generators'

const definitions = '/api/v2/work-patch-generators'
const runs = '/api/v2/work-patch-generation-runs'
const generator: Generator = { id: 'report', name: '周报', revision: 1, aliases: ['Second', 'first'], script: 'def transform(item, resources):\n    pass\n' }
const here = '/work-patch-generators/report'
const runFixture: GenerationRun = { id: 'run-1', generator: { id: 'report', revision: 1 }, resources: [], status: 'running', startedAt: 1700000000000 }

function renderAt(path: string) {
  const router = createMemoryRouter(workPatchGeneratorRoutes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => setToken('test-token'))
afterEach(() => {
  cleanup()
  setToken('')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('发布及发布新版后可从历史打开旧脚本和原别名', async () => {
  let history: Generator[] = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === definitions && init.method === 'POST') {
      const revision = history.length + 1
      const body = JSON.parse(String(init.body))
      expect(Object.keys(body).sort()).toEqual(['aliases', 'id', 'name', 'script'])
      const saved = { ...body, revision }
      history = [saved, ...history]
      return Response.json(saved)
    }
    if (url === `${definitions}/report`) return Response.json(history[0])
    if (url === `${definitions}/report/revisions`) return Response.json(history)
    if (url.startsWith(`${definitions}/report/revisions/`)) return Response.json(history.find(v => String(v.revision) === url.split('/').at(-1)))
    if (url === '/api/v2/mcp-servers') return Response.json([])
    throw Error(`意外请求：${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  renderAt('/work-patch-generators/new')
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('生成器 ID'), 'report')
  await user.type(screen.getByLabelText('名称'), '周报')
  await user.type(screen.getByLabelText('输入别名（每行一个）'), 'Second\nfirst')
  await user.type(screen.getByLabelText('Python 脚本'), generator.script)
  await user.click(screen.getByRole('button', { name: '发布生成器' }))
  expect(await screen.findByText('report · 第 1 版')).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: '发布新版' }))
  expect(await screen.findByLabelText('生成器 ID')).toHaveAttribute('readonly')
  await user.clear(screen.getByLabelText('输入别名（每行一个）'))
  await user.click(screen.getByRole('button', { name: '发布新版' }))
  expect(await screen.findByText('report · 第 2 版')).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: '历史版本' }))
  await user.click(await screen.findByRole('link', { name: '第 1 版' }))
  expect(await screen.findByLabelText('Second 的 MCP 服务')).toBeInTheDocument()
  expect(screen.getByLabelText('first 的 MCP 服务')).toBeInTheDocument()
  expect(screen.getByText(generator.script, { normalizer: value => value })).toBeInTheDocument()
})

it('试运行按版本别名顺序提交，内网 UUID 在响应丢失后原样重试，并轮询到只读结果', async () => {
  let attempts = 0
  let polls = 0
  const puts: { url: string; body: unknown }[] = []
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) })
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === `${definitions}/report`) return Response.json(generator)
    if (url === '/api/v2/mcp-servers') return Response.json([{ id: 'docs', name: '文档' }])
    if (url === '/api/v2/mcp-servers/docs/resources') return Response.json([{ name: '项目', uri: 'doc://project' }])
    if (url.startsWith(`${runs}/`)) {
      const snapshot = { ...runFixture, id: url.split('/').at(-1), resources: [
        { alias: 'Second', serverId: 'docs', uri: 'doc://project' }, { alias: 'first', serverId: 'docs', uri: 'doc://project' },
      ] }
      if (init.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) })
        if (++attempts === 1) throw Error('网络断开')
        return Response.json(snapshot)
      }
      if (++polls === 1) return Response.json(snapshot)
      return Response.json({ ...snapshot, status: 'succeeded', finishedAt: snapshot.startedAt + 1000,
        result: { name: '包', directoryId: 'files', files: [{ path: 'folder/a.txt', bytes: 9, sha256: 'abc' }] } })
    }
    if (url === '/api/v2/directories/files/file?path=folder%2Fa.txt') return new Response('read only', { headers: { 'Content-Type': 'application/octet-stream' } })
    throw Error(`意外请求：${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const router = renderAt(here)
  const user = userEvent.setup()
  const trial = () => screen.getByRole('button', { name: '试运行' })
  expect(await screen.findByRole('button', { name: '试运行' })).toBeDisabled()
  for (const alias of ['first', 'Second']) {
    const server = screen.getByLabelText(`${alias} 的 MCP 服务`)
    await within(server).findByRole('option', { name: '文档 · docs' })
    await user.selectOptions(server, 'docs')
    const resource = screen.getByLabelText(`${alias} 的 MCP 资源`)
    await within(resource).findByRole('option', { name: /项目/ })
    await user.selectOptions(resource, 'doc://project')
  }
  await user.click(trial())
  expect(await screen.findByRole('alert')).toHaveTextContent('网络断开')
  await user.click(trial())
  expect(await screen.findByText('运行中')).toBeInTheDocument()
  expect(puts).toHaveLength(2)
  expect(puts[1]).toEqual(puts[0])
  expect(puts[0]).toEqual({ url: `${runs}/ffffffff-ffff-4fff-bfff-ffffffffffff`, body: { generator: { id: 'report', revision: 1 }, resources: [
    { alias: 'Second', serverId: 'docs', uri: 'doc://project' }, { alias: 'first', serverId: 'docs', uri: 'doc://project' },
  ] } })
  const file = await screen.findByRole('button', { name: 'folder/a.txt' }, { timeout: 4000 })
  expect(router.state.location.pathname).toBe('/work-patch-generation-runs/ffffffff-ffff-4fff-bfff-ffffffffffff')
  expect(screen.getByRole('link', { name: 'report · 第 1 版' })).toHaveAttribute('href', `${here}/revisions/1`)
  await user.click(file)
  expect(await screen.findByLabelText('folder/a.txt 内容')).toHaveTextContent('read only')
  expect(screen.getByRole('button', { name: '下载文件' })).toBeEnabled()
  expect(fetch.mock.calls.filter(([url]) => url.includes('/directories/')).map(([, init]) => init.method)).toEqual([undefined])
})

it('保留历史筛选参数并显示失败阶段，隐藏失败结果文件', async () => {
  const failed = { ...runFixture, status: 'failed', workItemId: 'item/1', workItemTitle: '工作项快照',
    error: { stage: 'read', message: '资源不可用' }, result: { name: '不可见', directoryId: 'incomplete', files: [] } }
  const fetch = vi.fn(async (url: string) => {
    if (url === `${runs}/run-1`) return Response.json(failed)
    if (url === `${runs}?generatorId=report&workItemId=item%2F1`) return Response.json([{ ...failed, result: undefined }])
    if (url === runs) return Response.json([])
    throw Error(`意外请求：${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const router = renderAt('/work-patch-generation-runs?workItemId=item%2F1')
  const user = userEvent.setup()
  expect(await screen.findByLabelText('工作项 ID')).toHaveValue('item/1')
  await user.type(screen.getByLabelText('生成器 ID'), 'report')
  await user.click(screen.getByRole('button', { name: '筛选' }))
  await waitFor(() => expect(router.state.location.search).toBe('?generatorId=report&workItemId=item%2F1'))
  await user.click(await screen.findByRole('link', { name: '工作项快照' }))
  expect(await screen.findByText('read：资源不可用')).toBeInTheDocument()
  expect(screen.queryByText('不可见')).toBeNull()
  expect(screen.getByRole('link', { name: '工作项快照' })).toHaveAttribute('href', '/work-items/item%2F1')
})
