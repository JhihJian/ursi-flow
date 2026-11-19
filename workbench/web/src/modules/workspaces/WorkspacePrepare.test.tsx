import { afterEach, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { detail, json, mountWorkspace } from './test-utils'

afterEach(() => { cleanup(); sessionStorage.clear() })

it('执行前先保存未保存的需求，然后发起一次尝试并进入结果页', async () => {
  const user = userEvent.setup()
  const saved = detail({ requirement: '新的排查需求' })
  const executed = detail({
    requirement: '新的排查需求',
    attempts: [{ id: 'attempt-1', status: 'succeeded' }],
  })
  const { router, calls } = mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1' && (options.method ?? 'GET') === 'GET') {
      return json(calls.some(call => call.options.method === 'PATCH') ? executed : detail({ materials: [
        { role: 'finding', name: 'finding.md', size: 3 }, { role: 'source', name: 'source.zip', size: 4 },
      ] }))
    }
    if (path === '/workspaces/W-1' && options.method === 'PATCH') return json(saved)
    if (path === '/workspaces/W-1/attempts' && options.method === 'POST') return json(executed)
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  const draft = await screen.findByLabelText('需求')
  await user.clear(draft)
  await user.type(draft, '新的排查需求')
  await user.click(screen.getByRole('button', { name: '执行一次' }))

  expect(await screen.findByRole('heading', { name: '执行结果' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/workspaces/W-1/result')
  const writes = calls.filter(call => call.options.method === 'PATCH' || call.options.method === 'POST')
  expect(writes.map(call => [call.path, call.options.method])).toEqual([
    ['/workspaces/W-1', 'PATCH'],
    ['/workspaces/W-1/attempts', 'POST'],
  ])
  expect(JSON.parse(String(writes[0].options.body))).toEqual({ requirement: '新的排查需求' })
  expect(String(writes[1].options.body)).toBe('{}')
})

it('按角色上传文件时发送原始字节和编码后的文件名', async () => {
  const user = userEvent.setup()
  const file = new File(['finding body'], 'finding.txt', { type: 'text/plain' })
  const uploaded = detail({ materials: [{ role: 'finding', name: 'finding.txt', size: file.size }] })
  const { calls } = mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path.startsWith('/workspaces/W-1/materials/') && options.method === 'PUT') return json(uploaded)
    if (path === '/workspaces/W-1') return json(detail())
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  const input = await screen.findByLabelText('选择Finding材料文件')
  expect(screen.getByRole('button', { name: '执行一次' })).toBeDisabled()
  await user.upload(input, file)
  await user.click(screen.getByRole('button', { name: '上传Finding材料' }))

  expect(await screen.findByText('finding.txt · 12 B')).toBeVisible()
  const put = calls.find(call => call.options.method === 'PUT')
  expect(put?.path).toBe('/workspaces/W-1/materials/finding?name=finding.txt')
  expect(put?.options.body).toBe(file)
  expect(new Headers(put?.options.headers).get('Content-Type')).toBe('application/octet-stream')
})

it('冻结后需求和材料只读，但仍可重新执行且不发送需求修改', async () => {
  const user = userEvent.setup()
  const frozen = detail({ frozen: true })
  const executed = detail({ frozen: true, attempts: [{ id: 'attempt-2', status: 'failed', error: '执行器异常' }] })
  const { calls } = mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1/attempts' && options.method === 'POST') return json(executed)
    if (path === '/workspaces/W-1') {
      return json(calls.some(call => call.options.method === 'POST') ? executed : frozen)
    }
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  expect(await screen.findByText(/工作区已冻结/)).toBeVisible()
  expect(screen.getByLabelText('需求')).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存需求' })).toBeDisabled()
  expect(screen.getByLabelText('选择Finding材料文件')).toBeDisabled()
  const run = screen.getByRole('button', { name: '执行一次' })
  expect(run).toBeEnabled()
  await user.click(run)

  expect(await screen.findByText(/执行器异常/)).toBeVisible()
  expect(calls.filter(call => call.options.method === 'PATCH')).toHaveLength(0)
  expect(calls.filter(call => call.options.method === 'POST')).toHaveLength(1)
})
