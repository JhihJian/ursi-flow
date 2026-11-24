import { test, expect } from '@playwright/test'

test('静态产物缺少 Gateway 配置时显示错误，不渲染实例和终端', async ({
  page,
}) => {
  const requests = [],
    sockets = []
  page.on('request', (r) => requests.push(new URL(r.url()).pathname))
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await page.goto('./#/sandboxes/' + 'a'.repeat(32))
  await expect(page.locator('.sbx-app')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  )
  await expect(page.getByRole('status')).toHaveText('未配置 Gateway 控制台重试')
  await expect(page.getByRole('region', { name: '端点工作台' })).toHaveCount(0)
  expect(sockets).toEqual([])
  expect(requests.some((path) => path.includes('/api/'))).toBe(false)
})

test('不接受旧演示配置', async ({ page }) => {
  await page.route('**/console-config.json', (route) =>
    route.fulfill({ json: { mode: 'demo' } }),
  )
  await page.goto('./#/sandboxes')
  await expect(page.getByRole('status')).toContainText('Gateway 控制台配置无效')
  await expect(page.getByRole('heading', { name: '实例列表' })).toHaveCount(0)
})
