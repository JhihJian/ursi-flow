import { expect, test } from '@playwright/test'

const id = 'a'.repeat(32)
const row = () => ({
  id,
  status: 'running',
  operation: null,
  revision: 1,
  error: null,
  spec: {
    image: 'node:22',
    labels: { name: 'workbench-web' },
    cpus: 1,
    memory_mb: 512,
  },
  resource: { generation: 1, data_generation: 1 },
  endpoints: [
    { name: 'ssh', protocol: 'ssh', port: 2222, ready: true, bundle: 'base' },
  ],
})

test('刷新保留当前连接，切换、端点失效、代际变化和离开详情时关闭', async ({
  page,
}) => {
  let snapshot = row()
  await page.route('**/console-config.json', (route) =>
    route.fulfill({
      json: { mode: 'gateway', manage: true, sshSandboxes: [id] },
    }),
  )
  await page.route('**/api/v1/capabilities', (route) =>
    route.fulfill({ json: { tunnel_enabled: true, capabilities: {} } }),
  )
  await page.route(`**/api/v1/sandboxes/${id}`, (route) =>
    route.fulfill({ json: snapshot }),
  )
  const sockets = [],
    closed = []
  await page.routeWebSocket('**/workbench/*/terminal', (ws) => {
    const index = sockets.push(ws.url())
    ws.onClose(() => closed.push(index))
  })
  await page.goto(`./#/sandboxes/${id}`)
  const tools = page.getByRole('region', { name: '端点工作台' })
  const status = tools.getByRole('status')
  const connect = tools.getByRole('button', { name: '连接', exact: true })
  const terminal = tools.getByRole('tab', { name: '终端' })
  const refresh = async () => {
    const result = page.waitForResponse((res) =>
      res.url().endsWith(`/sandboxes/${id}`),
    )
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await result
    await expect(
      page.getByRole('button', { name: '刷新', exact: true }),
    ).toBeEnabled()
  }
  await connect.click()
  await expect(status).toHaveText('已连接')
  await refresh()
  await expect(status).toHaveText('已连接')
  await page.setViewportSize({ width: 390, height: 820 })
  await expect(status).toHaveText('已连接')
  await page.setViewportSize({ width: 1280, height: 820 })
  await expect(status).toHaveText('已连接')
  expect(sockets).toHaveLength(1)
  expect(closed).toEqual([])

  await terminal.focus()
  await page.keyboard.press('ArrowRight')
  const ide = tools.getByRole('tab', { name: 'IDE' })
  await expect(ide).toBeFocused()
  await expect(terminal).toHaveAttribute('aria-selected', 'true')
  await expect(status).toHaveText('已连接')
  await page.keyboard.press('Enter')
  await expect(ide).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => closed.slice()).toEqual([1])

  await terminal.click()
  await connect.click()
  await expect(status).toHaveText('已连接')
  snapshot = { ...row(), endpoints: [] }
  await refresh()
  await expect(status).toHaveText('SSH 未就绪')
  await expect.poll(() => closed.slice()).toEqual([1, 2])
  snapshot = row()
  await refresh()
  await expect(status).toHaveText('未连接')
  expect(sockets).toHaveLength(2)

  await connect.click()
  await expect(status).toHaveText('已连接')
  snapshot.resource.generation = 2
  await refresh()
  await expect(status).toHaveText('未连接')
  await expect.poll(() => closed.slice()).toEqual([1, 2, 3])
  await connect.click()
  await expect(status).toHaveText('已连接')
  expect(sockets.at(-1)).toContain('/workbench/2/terminal')
  await page.getByRole('link', { name: '实例列表' }).click()
  await expect.poll(() => closed.slice()).toEqual([1, 2, 3, 4])
})
