import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  attempt, detail, findingType, json, mountWorkspace, sopV1, sopV2, text,
} from './test-utils'

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL
  else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL
  else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
})

const attempted = detail({
  frozen: true,
  attempts: [
    attempt({ id: 'attempt-ok', status: 'succeeded', sop: sopV1 }),
    attempt({ id: 'attempt-fail', status: 'failed', error: '执行器异常', sop: sopV2 }),
  ],
})

function serveSops(path: string) {
  if (path === '/workspace-types') return json([findingType])
  if (path === '/sops') return json([sopV1, sopV2])
  return null
}

it('结果页保留成功和失败尝试，逐次显示所用版本并读取成功回执', async () => {
  const user = userEvent.setup()
  const { calls } = mountWorkspace('/workspaces/W-1/result', path => {
    const sops = serveSops(path)
    if (sops) return sops
    if (path.endsWith('/receipt')) return text('# 回执\n共 2 份材料')
    return json(attempted)
  })

  expect(await screen.findByText(/执行器异常/)).toBeVisible()
  expect(screen.getByText('2 次执行 · 最近失败')).toBeVisible()
  const okRow = screen.getByText('attempt-ok').closest('li')!
  const failRow = screen.getByText('attempt-fail').closest('li')!
  expect(within(okRow).getByText(/材料接收回执 · receipt v1/)).toBeVisible()
  expect(within(failRow).getByText(/项目交接记录 · receipt v2/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: '查看回执 attempt-ok' }))

  expect(await screen.findByText(/共 2 份材料/)).toBeVisible()
  expect(calls.some(call => call.path === '/workspaces/W-1/attempts/attempt-ok/receipt')).toBe(true)
})

it('回执不是纯文本时按读取失败报告，不影响尝试记录', async () => {
  const user = userEvent.setup()
  mountWorkspace('/workspaces/W-1/result', path => {
    const sops = serveSops(path)
    if (sops) return sops
    if (path.endsWith('/receipt')) {
      return new Response('<!doctype html><title>登录</title>', { headers: { 'Content-Type': 'text/html' } })
    }
    return json(attempted)
  })

  await screen.findByText(/执行器异常/)
  await user.click(screen.getByRole('button', { name: '查看回执 attempt-ok' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('读取回执失败')
  expect(screen.getByText(/执行器异常/)).toBeVisible()
})

it('下载回执读取鉴权正文并由浏览器保存为 receipt.md', async () => {
  const user = userEvent.setup()
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:receipt')
  const revokeObjectURL = vi.fn()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const { calls } = mountWorkspace('/workspaces/W-1/result', path => {
    const sops = serveSops(path)
    if (sops) return sops
    if (path.includes('/receipt')) return text('# 回执\n下载正文')
    return json(attempted)
  })

  await screen.findByText(/执行器异常/)
  await user.click(screen.getByRole('button', { name: '下载回执 attempt-ok' }))

  expect(calls.some(call => call.path === '/workspaces/W-1/attempts/attempt-ok/receipt?download=true')).toBe(true)
  await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
  const blob = createObjectURL.mock.calls[0][0] as Blob
  expect(blob.type).toBe('text/plain;charset=utf-8')
  expect(blob.size).toBeGreaterThan(0)
  expect(click).toHaveBeenCalled()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:receipt')
})

it('结果页可按最新版本显式换版重跑并追加新的尝试记录', async () => {
  const user = userEvent.setup()
  const initial = detail({ frozen: true, attempts: [attempt({ id: 'attempt-ok', status: 'succeeded', sop: sopV1 })] })
  const rerun = detail({
    frozen: true,
    attempts: [
      ...initial.attempts,
      attempt({ id: 'attempt-fail', status: 'failed', error: '执行器异常', sop: sopV1 }),
      attempt({ id: 'attempt-3', status: 'succeeded', sop: sopV2 }),
    ],
  })
  const { calls } = mountWorkspace('/workspaces/W-1/result', (path, options) => {
    const sops = serveSops(path)
    if (sops) return sops
    if (path.endsWith('/receipt')) return text('# 回执\n重跑正文')
    if (path === '/workspaces/W-1/attempts' && options.method === 'POST') return json(rerun)
    return json(initial)
  })

  await screen.findByText('1 次执行 · 最近已执行')
  const select = await screen.findByRole('combobox', { name: 'SOP 版本' })
  await waitFor(() => expect(select).toHaveValue('receipt@1'))
  await user.selectOptions(select, 'receipt@2')
  await user.click(screen.getByRole('button', { name: '再执行一次' }))

  expect(await screen.findByText('3 次执行 · 最近已执行')).toBeVisible()
  const post = calls.find(call => call.options.method === 'POST')
  expect(JSON.parse(String(post!.options.body))).toEqual({ sop: { id: 'receipt', revision: 2 } })
  const row = screen.getByText('attempt-3').closest('li')!
  expect(within(row).getByText(/项目交接记录 · receipt v2/)).toBeVisible()
})
