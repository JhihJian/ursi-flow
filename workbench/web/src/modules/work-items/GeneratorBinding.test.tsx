import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { setToken } from '@/shared/http/session'
import type { WorkItem } from '@/shared/api/work-items'
import { workPatchGeneratorRoutes } from '@/modules/work-patch-generators/routes'
import { workItemRoutes } from './routes'

const itemPath = '/work-items/item-1'
const generatorId = 'report'
const newest = { id: generatorId, name: '新版', revision: 2, aliases: [], script: 'pass' }
const older = { ...newest, name: '旧版', revision: 1, aliases: ['Source'] }
const ref = { alias: 'Source', serverId: 'docs', uri: 'doc://source' }
const initial: WorkItem = { id: 'item-1', title: '周报整理', description: '', status: 'active', category: 'continuous', revision: 1, recipe: null }

beforeEach(() => setToken('test-token'))
afterEach(() => { cleanup(); setToken(''); vi.unstubAllGlobals() })

it('可从配方切到旧版生成器，绑定后使用已保存配置运行，并可解除绑定', async () => {
  const user = userEvent.setup()
  const updates: unknown[] = []
  let item = { ...initial, recipe: { script: 'pass', resources: [ref] } } as WorkItem
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === `/api/v2${itemPath}`) {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        updates.push(body)
        item = { ...item, ...body, revision: item.revision + 1 }
      }
      return Response.json(item)
    }
    if (url === '/api/v2/work-patch-generators') return Response.json([newest])
    if (url === `/api/v2/work-patch-generators/${generatorId}/revisions`) return Response.json([older, newest])
    if (url === '/api/v2/mcp-servers') return Response.json([{ id: ref.serverId, name: '文档' }])
    if (url === '/api/v2/mcp-servers/docs/resources') return Response.json([{ name: '来源', uri: ref.uri }])
    if (url === '/api/v2/patches/work') return Response.json([])
    if (url.startsWith('/api/v2/work-patch-generation-runs/')) {
      if (init.method === 'PUT') expect(JSON.parse(String(init.body))).toEqual({ workItemId: item.id })
      return Response.json({ id: url.split('/').at(-1), generator: { id: generatorId, revision: 1 }, workItemId: item.id,
        workItemTitle: item.title, resources: [ref], status: 'succeeded', startedAt: 1700000000000,
        result: { name: '生成的周报', directoryId: 'd1', workPatchId: 'p1', files: [] } })
    }
    throw Error(`意外请求：${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const router = createMemoryRouter([...workItemRoutes, ...workPatchGeneratorRoutes], { initialEntries: [`${itemPath}/edit`] })
  render(<RouterProvider router={router} />)
  expect(await screen.findByLabelText('Python 脚本')).toHaveValue('pass')
  await user.selectOptions(screen.getByLabelText('工作包来源类型'), 'generator')
  const generator = screen.getByLabelText('生成器', { exact: true })
  await within(generator).findByRole('option', { name: '新版 · report' })
  await user.selectOptions(generator, generatorId)
  const revision = screen.getByLabelText('生成器版本')
  await within(revision).findByRole('option', { name: '第 1 版 · 旧版' })
  await user.selectOptions(revision, '1')
  await user.click(screen.getByRole('button', { name: '保存工作项' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请为每个输入别名选择 MCP 资源')
  expect(updates).toHaveLength(0)
  await user.selectOptions(screen.getByLabelText('Source 的 MCP 服务'), ref.serverId)
  const resource = screen.getByLabelText('Source 的 MCP 资源')
  await within(resource).findByRole('option', { name: /来源/ })
  await user.selectOptions(resource, ref.uri)
  await user.click(screen.getByRole('button', { name: '保存工作项' }))
  expect(await screen.findByRole('link', { name: 'report · 第 1 版' })).toHaveAttribute('href', '/work-patch-generators/report/revisions/1')
  expect(updates[0]).toMatchObject({ revision: 1, category: 'continuous', status: 'active', recipe: null,
    generator: { id: generatorId, revision: 1, resources: [ref] } })
  expect(screen.getByRole('link', { name: '生成记录' })).toHaveAttribute('href', '/work-patch-generation-runs?workItemId=item-1')
  await user.click(screen.getByRole('button', { name: '生成工作包' }))
  expect(await screen.findByRole('link', { name: '打开工作包' })).toHaveAttribute('href', '/work-patches/p1')
  await user.click(screen.getByRole('link', { name: item.title }))
  await user.click(await screen.findByRole('link', { name: '编辑工作项' }))
  expect(await screen.findByLabelText('生成器版本')).toHaveValue('1')
  await user.click(screen.getByLabelText('配置工作包来源'))
  await user.click(screen.getByRole('button', { name: '保存工作项' }))
  expect(await screen.findByText('未配置工作包来源')).toBeInTheDocument()
  expect(updates[1]).toMatchObject({ revision: 2, recipe: null, generator: null })
})
