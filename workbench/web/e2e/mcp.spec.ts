import { expect, expectNoOverflow, test } from './fixtures'

test('在宿主管理凭据，配方使用同一登记，删除凭据后深链显示读取失败', async ({ page }) => {
  const server = { id: 'weekly', name: '周报服务', url: 'https://fixture.example/mcp', credentialEnv: 'TEAM_TOKEN' }
  const resource = { name: '例会纪要', uri: 'memo:weekly' }
  let registered = false
  let hasCredential = true
  await page.route('**/api/**', route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    expect(req.headers().authorization).toBe('Bearer mcp-test')
    if (path === '/api/v2/platform-env') return route.fulfill({ json: hasCredential ? [server.credentialEnv] : [] })
    if (path === '/api/v2/platform-env/TEAM_TOKEN' && req.method() === 'DELETE') {
      hasCredential = false
      return route.fulfill({ json: { name: server.credentialEnv } })
    }
    if (path === '/api/v2/mcp-servers') {
      if (req.method() === 'GET') return route.fulfill({ json: registered ? [server] : [] })
      expect(req.postDataJSON()).toEqual({ name: server.name, url: server.url, credentialEnv: server.credentialEnv, binding: 'platform' })
      registered = true
      return route.fulfill({ json: server })
    }
    if (path.endsWith('/resources')) return route.fulfill({ json: [resource] })
    if (path.endsWith('/inspection')) return hasCredential ? route.fulfill({ json: { resources: [resource] } })
      : route.fulfill({ status: 400, json: { error: '平台凭据不存在' } })
    if (path.endsWith('/resources/read')) return route.fulfill({ json: { contents: [{ uri: resource.uri, text: '会议正文' }] } })
    throw Error(`未预期的请求：${path}`)
  })
  await page.goto('/mcp-servers')
  await page.getByLabel('访问令牌').fill('mcp-test')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '登记服务' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('link', { name: '管理平台变量' })).toHaveAttribute('href', '/platform-env')
  await dialog.getByLabel('服务名称').fill(server.name)
  await dialog.getByLabel('服务地址').fill(server.url)
  await dialog.getByLabel('平台凭据').selectOption(server.credentialEnv)
  await dialog.getByRole('button', { name: '添加服务' }).click()
  await page.getByRole('link', { name: '浏览资源' }).click()
  await page.getByRole('button', { name: resource.name }).click()
  await expect(page.getByText('会议正文')).toBeVisible()
  const deepLink = page.url()
  await expectNoOverflow(page)
  await page.goto('/work-items/new')
  await page.getByLabel('配置工作包来源').check()
  await page.getByLabel('资源服务').selectOption(server.id)
  await page.getByLabel(`${resource.name} · ${resource.uri}`).check()
  await expect(page.getByLabel('资源别名 1')).toBeVisible()
  await page.goto('/platform-env')
  await page.getByRole('button', { name: '删除 TEAM_TOKEN' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await expect(page.getByText('暂无平台变量')).toBeVisible()
  await page.goto(deepLink)
  await expect(page.getByRole('alert')).toContainText('平台凭据不存在')
  await expect(page.getByText('会议正文')).toHaveCount(0)
})
