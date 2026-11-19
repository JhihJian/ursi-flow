import { afterEach, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { detail, findingType, json, mountWorkspace } from './test-utils'

afterEach(() => { cleanup(); sessionStorage.clear() })

it('列表显示过去创建的工作区、类型、材料、执行状态和冻结情况', async () => {
  const workspace = detail({
    materials: [{ role: 'finding', name: 'finding.txt', size: 1536 }],
    attempts: [{ id: 'attempt-1', status: 'failed', error: '执行器返回错误' }],
  })
  mountWorkspace('/workspaces', path =>
    path === '/workspace-types' ? json([findingType]) : json([workspace]))

  const row = await screen.findByRole('link', { name: /排查线索 A/ })
  expect(row).toHaveAttribute('href', '/workspaces/W-1')
  expect(row).toHaveTextContent('单条线索报告')
  expect(row).toHaveTextContent('材料 1 份')
  expect(row).toHaveTextContent('执行 1 次')
  expect(row).toHaveTextContent('最近失败')
  expect(row).toHaveTextContent('可编辑')
  expect(screen.getByRole('link', { name: '新建工作区' })).toHaveAttribute('href', '/workspaces/new')
})

it('列表为空显示空态和新建入口，加载失败可重试', async () => {
  let failing = true
  mountWorkspace('/workspaces', path => {
    if (path === '/workspace-types') return json([findingType])
    return failing ? json({ error: '目录暂不可用' }, { status: 500 }) : json([])
  })

  expect(await screen.findByRole('alert')).toHaveTextContent('目录暂不可用')
  failing = false
  await userEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(await screen.findByText('暂无工作区')).toBeVisible()
  const links = screen.getAllByRole('link', { name: '新建工作区' })
  expect(links).toHaveLength(2)
  links.forEach(link => expect(link).toHaveAttribute('href', '/workspaces/new'))
})

it('新建页选类型、填需求后创建工作区并进入准备页', async () => {
  const user = userEvent.setup()
  const created = detail()
  const { router, calls } = mountWorkspace('/workspaces/new', (path, options) => {
    if (path === '/workspace-types') return json([findingType])
    if (path === '/workspaces' && options.method === 'POST') return json(created)
    if (path === '/workspaces/W-1') return json(created)
    return json({ error: `意外请求 ${path}` }, { status: 500 })
  })

  expect(await screen.findByText('单条线索报告')).toBeVisible()
  expect(screen.getByText(/Finding、源码包/)).toBeVisible()
  expect(screen.getByText(/材料接收回执/)).toBeVisible()
  await user.type(screen.getByLabelText('需求'), '分析这批线索')
  await user.click(screen.getByRole('button', { name: '创建工作区' }))

  expect(await screen.findByRole('heading', { name: '准备工作区' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/workspaces/W-1')
  const post = calls.find(call => call.path === '/workspaces' && call.options.method === 'POST')
  expect(post).toBeDefined()
  expect(JSON.parse(String(post!.options.body))).toEqual({
    typeId: 'finding-report',
    requirement: '分析这批线索',
  })
})

it('需求为空时不能提交创建', async () => {
  mountWorkspace('/workspaces/new', () => json([findingType]))
  await screen.findByText('单条线索报告')
  expect(screen.getByRole('button', { name: '创建工作区' })).toBeDisabled()
})
