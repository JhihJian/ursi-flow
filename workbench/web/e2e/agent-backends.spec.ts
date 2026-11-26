import { expect, expectNoOverflow, navigate, test } from './fixtures'

test('从后端设置检查并返回草稿，只能选择就绪且兼容的后端', async ({ page }, info) => {
  await page.addInitScript(() => sessionStorage.setItem('ursi-flow:bearer', 'test'))
  const configPackageId = 'policy+review'
  const first = { id: 'first', label: '通用适配器', capabilities: ['skills', 'tools'], configured: true, status: 'unchecked', checkedAt: null as number | null }
  const other = { ...first, id: 'other', label: '工具适配器', status: 'ready', checkedAt: 1700000000000 }
  const rows = [first, other, { ...other, id: 'offline', label: '备用适配器', status: 'failed' }, { ...first, id: 'unset', label: '未启用适配器', configured: false }, { ...other, id: 'mismatch', label: '其他适配器' }]
  let checks = 0
  let matches = 0
  await page.route('**/api/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'GET') {
      if (url.pathname === '/api/v2/patches/work') return route.fulfill({ json: [] })
      if (url.pathname === '/api/v2/patches/config') return route.fulfill({ json: [{ id: configPackageId, name: '核对配置', directoryId: 'private-directory' }] })
      if (url.pathname === '/api/v2/agent-backends') {
        if (!url.search) return route.fulfill({ json: rows })
        expect(url.searchParams.get('configPackageId')).toBe(configPackageId)
        matches++
        return route.fulfill({ json: rows.map(b => ({ ...b, compatible: b.id !== 'mismatch' && (b.id !== 'other' || checks > 0) })) })
      }
    } else if (req.method() === 'POST' && url.pathname === '/api/v2/agent-backends/first/check') {
      checks++
      first.status = 'ready'; first.checkedAt = 1700000123000
      return route.fulfill({ json: first })
    }
    throw new Error(`未预期的请求 ${req.method()} ${url.pathname}`)
  })
  await page.goto('/not-found')
  await navigate(page, 'Agent 后端')
  await expect(page.getByRole('heading', { name: 'Agent 后端', exact: true })).toBeVisible()
  await expect(page.getByText('未配置', { exact: true })).toBeVisible()
  await expect(page.getByText('检查失败', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '检查 未启用适配器 连通性' })).toBeDisabled()
  await expect(page.getByText(/仅验证适配器控制接口/)).toBeVisible()
  await expectNoOverflow(page)
  await page.screenshot({ path: info.outputPath('agent-backends.png') })

  await page.goto('/executors/new?mode=agent')
  await page.getByLabel('执行器 ID').fill('review')
  await page.getByLabel('配置包', { exact: true }).selectOption(configPackageId)
  await expect(page.getByText(/没有可用的 Agent 后端/)).toContainText('尚未检查连通性')
  await expect(page.getByRole('button', { name: '发布执行器' })).toBeDisabled()
  await page.getByRole('link', { name: '查看 Agent 后端设置' }).click()
  expect(checks).toBe(0)
  const row = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '通用适配器' }) })
  await row.getByRole('button').click()
  await expect(row.getByText('已连通')).toBeVisible()
  await expect(row.locator('time')).toHaveAttribute('datetime', '2023-11-14T22:15:23.000Z')
  await page.getByRole('button', { name: '返回执行器草稿' }).click()
  await expect(page).toHaveURL(/\/executors\/new\?mode=agent$/)
  await expect(page.getByLabel('执行器 ID')).toHaveValue('review')
  const choice = page.getByLabel('Agent 后端', { exact: true })
  await expect(choice).toHaveValue('')
  await expect(choice.locator('option')).toHaveText(['选择可用后端', '通用适配器（first）', '工具适配器（other）'])
  await expect(page.getByRole('button', { name: '发布执行器' })).toBeDisabled()
  await choice.selectOption('other')
  await expect(page.getByRole('button', { name: '发布执行器' })).toBeEnabled()
  await expectNoOverflow(page)
  expect(matches).toBe(2)
  expect(checks).toBe(1)
})
