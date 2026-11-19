import { test, expect, openNavigation, expectNoOverflow } from './fixtures'

/**
 * 工作台入口回归。业务数据与可选模块探测全部用 `page.route` 替身：
 * 这里验证的是登录还原、导航装配和交付正文契约，不连接真实 Server。
 */

const workItem = {
  id: 'item-1',
  package: 'example',
  revision: 1,
  assignee: 'Lin',
  status: 'review',
  input: {},
  source: { type: 'builtin' },
  packageSnapshot: { sop: '检查日志', acceptance: '报告覆盖结论', deliverables: ['report.txt'], actions: {} },
  attempts: [],
  deliveries: [{ version: 2, files: { 'report.txt': '' }, attemptIds: [], review: null }],
  acceptedVersion: null,
}

const token = 'entry-canary'

test('指定交付深链登录后原址还原，退出后不再展示服务端数据', async ({ page }) => {
  const seen: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api\/v[12]/, '')
    seen.push(`${request.method()} ${path}`)
    expect(request.headers().authorization).toBe(`Bearer ${token}`)
    switch (path) {
      case '/sources':
      case '/flows': return route.fulfill({ json: [] })
      case '/items/item-1': return route.fulfill({ json: workItem })
      case '/items/item-1/deliveries/2/files/report.txt':
        return route.fulfill({ body: '第二版报告\n第二行\n', contentType: 'text/plain' })
      default: throw Error(`意外 API：${path}`)
    }
  })

  await page.goto('/items/item-1/deliveries/2?status=review#report')
  await expect(page.getByLabel('访问令牌')).toBeVisible()
  expect(seen).toEqual([])

  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/items\/item-1\/deliveries\/2\?status=review#report$/)
  await expect(page.getByRole('heading', { name: '第 2 版交付文件' })).toBeVisible()
  await expect(page.getByText('第二版报告')).toBeVisible()
  await expect(page.getByText('报告覆盖结论')).toBeVisible()
  await expectNoOverflow(page)

  await openNavigation(page)
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByLabel('访问令牌')).toBeVisible()
  await expect(page.getByText('第二版报告')).toHaveCount(0)
  await expect(page).toHaveURL(/\/items\/item-1\/deliveries\/2\?status=review#report$/)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token)
})

test('交付正文不是纯文本时报告读取失败', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v[12]/, '')
    switch (path) {
      case '/sources':
      case '/flows': return route.fulfill({ json: [] })
      case '/items/item-1': return route.fulfill({ json: workItem })
      // 开发代理或静态服务误把首页当成交付正文：必须报错，不能当成验收材料。
      case '/items/item-1/deliveries/2/files/report.txt':
        return route.fulfill({ body: '<!doctype html><html><body>代理首页</body></html>', contentType: 'text/html; charset=utf-8' })
      default: throw Error(`意外 API：${path}`)
    }
  })

  await page.goto('/items/item-1/deliveries/2')
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText(/交付文件必须是纯文本/)).toBeVisible()
  await expect(page.getByText('代理首页')).toHaveCount(0)
})

test('未知地址回到工作清单，登录后清单可用', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v2/items') return route.fulfill({ json: [] })
    return route.fulfill({ json: [] })
  })

  await page.goto('/not-a-page')
  await expect(page.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  await page.getByRole('link', { name: '返回工作清单' }).click()
  await expect(page).toHaveURL(/\/items$/)
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无工作项')).toBeVisible()
  await expectNoOverflow(page)
})

test('只有集合 404 收起入口，空集合仍保留入口', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v2/sources') return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } })
    if (path === '/api/v2/items') return route.fulfill({ json: [] })
    return route.fulfill({ json: [] })
  })

  await page.goto('/items')
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无工作项')).toBeVisible()

  await openNavigation(page)
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('link', { name: '外部来源' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Flow 包' })).toBeVisible()
  await expect(nav.getByRole('link', { name: '工作包' })).toBeVisible()

  // 来源未启用时直接打开该模块仍能回到清单。
  await page.goto('/sources')
  await expect(page.getByRole('heading', { name: '外部来源未启用' })).toBeVisible()
  await page.getByRole('link', { name: '返回工作清单' }).click()
  await expect(page).toHaveURL(/\/items$/)
})

test('可选模块故障可单独重试且不阻塞清单', async ({ page }) => {
  let sourcesFails = true
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v2/items') return route.fulfill({ json: [] })
    if (path === '/api/v1/flows') return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } })
    if (path === '/api/v2/sources') {
      if (sourcesFails) { sourcesFails = false; return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }) }
      return route.fulfill({ json: [] })
    }
    throw Error(`意外 API：${path}`)
  })

  await page.goto('/items')
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('暂无工作项')).toBeVisible()
  await expect(page.getByText(/外部来源检查失败：HTTP 503/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重试外部来源' })).toBeVisible()

  await openNavigation(page)
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('link', { name: '外部来源' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Flow 包' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '重试外部来源' }).click()
  await expect(page.getByText(/外部来源检查失败/)).toHaveCount(0)
  await expect(page.getByText('暂无工作项')).toBeVisible()
})

test('旧 Flow 深链在模块未挂载时回到清单', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/flows') return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } })
    return route.fulfill({ json: [] })
  })

  await page.goto('/flows')
  await page.getByLabel('访问令牌').fill(token)
  await page.getByRole('button', { name: '登录', exact: true }).click()

  for (const path of ['/flows', '/runs/r1', '/flow-config']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Flow 工具未启用' })).toBeVisible()
    await expect(page.getByRole('link', { name: '返回工作清单' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
  }
})
