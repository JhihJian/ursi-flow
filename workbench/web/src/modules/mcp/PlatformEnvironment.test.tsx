import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setToken } from '@/shared/http/session'
import { PlatformEnvironment } from './PlatformEnvironment'

afterEach(() => { cleanup(); setToken(''); vi.unstubAllGlobals() })

it('新增、空白值轮换与确认删除；列表只取名称', async () => {
  setToken('test')
  const name = 'GITHUB_PAT_TOKEN'
  let names: string[] = []
  const requests: unknown[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (!init.method) return Response.json(names)
    requests.push([init.method, path, init.body && JSON.parse(String(init.body))])
    names = init.method === 'DELETE' ? [] : [name]
    return Response.json({ name })
  })
  const user = userEvent.setup()
  render(<PlatformEnvironment />)
  await screen.findByText('暂无平台变量')
  await user.click(screen.getByRole('button', { name: '新增变量' }))
  await user.type(screen.getByLabelText('变量名'), name)
  expect(screen.getByLabelText('新值')).toHaveAttribute('type', 'password')
  await user.type(screen.getByLabelText('新值'), 'first')
  await user.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByText(name)
  await user.click(screen.getByRole('button', { name: '替换值' }))
  expect(screen.getByLabelText('新值')).toHaveValue('')
  await user.type(screen.getByLabelText('新值'), 'second')
  await user.click(screen.getByRole('button', { name: '保存' }))
  await user.click(await screen.findByRole('button', { name: `删除 ${name}` }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
  expect(requests).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: `删除 ${name}` }))
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await screen.findByText('暂无平台变量')
  expect(requests).toEqual([
    ['POST', '/api/v2/platform-env', { name, value: 'first' }],
    ['PUT', `/api/v2/platform-env/${name}`, { value: 'second' }],
    ['DELETE', `/api/v2/platform-env/${name}`, undefined],
  ])
})
