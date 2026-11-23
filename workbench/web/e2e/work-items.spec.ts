import { expect, expectNoOverflow, test } from './fixtures'

const items = [
  { id: 'weekly', title: '每周复核', category: 'continuous', status: 'active' },
  { id: 'daily', title: '每日整理', category: 'continuous', status: 'pending' },
  { id: 'audit', title: '季度验收', category: 'one_time', status: 'active' },
].map(item => ({ ...item, description: '', revision: 1 }))

test('类别与状态组合筛选，刷新和清除单个条件保留另一维度', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v2/work-items') return route.fulfill({ json: items })
    expect(['/api/v2/patches/work', '/api/v1/flows']).toContain(path)
    return route.fulfill({ json: [] })
  })
  await page.goto('/work-items?category=continuous')
  await page.getByLabel('访问令牌').fill('filter-test')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const category = page.getByRole('combobox', { name: '类别筛选' })
  const status = page.getByRole('combobox', { name: '状态筛选' })
  const rows = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: /每周复核|每日整理|季度验收/ }) })
  await expect(rows).toHaveText([/每周复核.*持续工作.*进行中/, /每日整理.*持续工作.*待开始/])
  await status.selectOption('active')
  await expect(page).toHaveURL(/\?category=continuous&status=active$/)
  await page.reload()
  await expect(category).toHaveValue('continuous')
  await expect(status).toHaveValue('active')
  await expect(rows).toHaveText([/每周复核.*持续工作.*进行中/])
  await expectNoOverflow(page)
  await category.selectOption('')
  await expect(page).toHaveURL(/\?status=active$/)
  await expect(rows).toHaveText([/每周复核/, /季度验收/])
  await category.selectOption('one_time')
  await expect(rows).toHaveText([/季度验收.*一次性工作.*进行中/])
  await status.selectOption('completed')
  await expect(page.getByText('暂无工作项')).toBeVisible()
  await status.selectOption('')
  await expect(page).toHaveURL(/\?category=one_time$/)
  await expect(rows).toHaveText([/季度验收/])
})
