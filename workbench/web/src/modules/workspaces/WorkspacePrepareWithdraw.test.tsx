import { afterEach, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { detail, json, mountWorkspace } from './test-utils'

afterEach(() => { cleanup(); sessionStorage.clear() })

const bothMaterials = detail({
  materials: [
    { role: 'finding', name: 'finding.txt', size: 12 },
    { role: 'source', name: 'source.zip', size: 4 },
  ],
})

it('撤回单个角色后该角色可重新上传，其他角色文件保留', async () => {
  const user = userEvent.setup()
  const withdrawn = detail({ materials: [{ role: 'source', name: 'source.zip', size: 4 }] })
  const reuploaded = detail({
    materials: [
      { role: 'source', name: 'source.zip', size: 4 },
      { role: 'finding', name: 'fixed.txt', size: 5 },
    ],
  })
  const { calls } = mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1/materials/finding' && options.method === 'DELETE') return json(withdrawn)
    if (path.startsWith('/workspaces/W-1/materials/finding?') && options.method === 'PUT') return json(reuploaded)
    if (path === '/workspaces/W-1') {
      return json(calls.some(call => call.options.method === 'PUT') ? reuploaded : bothMaterials)
    }
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  expect(await screen.findByText('finding.txt · 12 B')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '撤回Finding材料' }))

  expect(await screen.findByText('finding.txt 已撤回，可以重新上传。')).toBeVisible()
  expect(screen.getByText('source.zip · 4 B')).toBeVisible()
  expect(screen.queryByRole('button', { name: '撤回Finding材料' })).toBeNull()
  const deletes = calls.filter(call => call.options.method === 'DELETE')
  expect(deletes.map(call => call.path)).toEqual(['/workspaces/W-1/materials/finding'])

  const file = new File(['fixed'], 'fixed.txt', { type: 'text/plain' })
  await user.upload(screen.getByLabelText('选择Finding材料文件'), file)
  await user.click(screen.getByRole('button', { name: '上传Finding材料' }))

  expect(await screen.findByText('fixed.txt · 5 B')).toBeVisible()
  const put = calls.find(call => call.options.method === 'PUT')
  expect(put?.path).toBe('/workspaces/W-1/materials/finding?name=fixed.txt')
})

it('已执行过的工作包不再提供撤回', async () => {
  const executed = detail({
    attempts: [{ id: 'attempt-1', status: 'succeeded', sop: { id: 'receipt', revision: 1 } }],
    materials: [{ role: 'finding', name: 'finding.txt', size: 12 }],
  })
  mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1' && (options.method ?? 'GET') === 'GET') return json(executed)
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  expect(await screen.findByText('finding.txt · 12 B')).toBeVisible()
  expect(screen.queryByRole('button', { name: /撤回/ })).toBeNull()
})

it('冻结的工作包保留材料且不提供撤回', async () => {
  const frozen = detail({
    frozen: true,
    attempts: [{ id: 'attempt-1', status: 'failed', error: '执行器异常', sop: { id: 'receipt', revision: 1 } }],
    materials: [{ role: 'finding', name: 'finding.txt', size: 12 }],
  })
  mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1' && (options.method ?? 'GET') === 'GET') return json(frozen)
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  expect(await screen.findByText('finding.txt · 12 B')).toBeVisible()
  expect(screen.getByLabelText('选择Finding材料文件')).toBeDisabled()
  expect(screen.queryByRole('button', { name: /撤回/ })).toBeNull()
})

it('撤回失败时保留材料并显示错误', async () => {
  const user = userEvent.setup()
  const { calls } = mountWorkspace('/workspaces/W-1', (path, options) => {
    if (path === '/workspaces/W-1/materials/finding' && options.method === 'DELETE') {
      return json({ error: '工作区已冻结，不能再撤回材料' }, { status: 409 })
    }
    if (path === '/workspaces/W-1') return json(bothMaterials)
    return json({ error: `意外请求 ${options.method} ${path}` }, { status: 500 })
  })

  await user.click(await screen.findByRole('button', { name: '撤回Finding材料' }))

  expect(await screen.findByText(/工作区已冻结，不能再撤回材料/)).toBeVisible()
  expect(screen.getByText('finding.txt · 12 B')).toBeVisible()
  expect(calls.filter(call => call.options.method === 'DELETE')).toHaveLength(1)
})
