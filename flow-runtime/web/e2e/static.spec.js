import { expect, test } from '@playwright/test'

test('纯静态子目录：主题、列表、深链刷新与只读演示', async ({ page }) => {
  const base = 'http://127.0.0.1:14484/dist/'
  const paths = []
  page.on('request', (request) => paths.push(request.url()))
  await page.addInitScript(() => {
    localStorage.setItem('ursi-flow:theme', 'dark')
    localStorage.setItem('ursi-flow:palette', 'mono')
  })
  await page.goto(base)
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(9, 9, 9)')
  await expect(page.getByText('演示数据')).toBeVisible()
  // 列表是数据表格：名称、说明、节点数、修订与行内操作，可按列排序并按关键字筛选。
  const rows = page.locator('tbody tr')
  const release = rows.filter({ hasText: '发布检查' })
  await expect(release).toContainText('校验版本号与发布清单后完成发布。')
  await expect(rows).toHaveCount(2)
  await page.getByLabel('按名称排序').click()
  await expect(rows.first()).toContainText('发布检查')
  await page.getByLabel('按名称、说明或标识筛选').fill('release')
  await expect(page.getByText('1 / 2 个包')).toBeVisible()
  await expect(rows).toHaveCount(1)
  await page.getByLabel('按名称、说明或标识筛选').fill('')
  // 演示模式不能删除，按钮禁用但可见。
  await expect(page.getByRole('button', { name: /删除 ordinary/ })).toBeDisabled()
  await release.getByRole('link', { name: '发布检查' }).click()
  await expect(page).toHaveURL(/\/dist\/#\/flows\/release-check\/edit$/)
  await page.reload()
  // 演示包默认打开图形视图，FLOW.md 只有图形与文档两个视图。
  await expect(page.locator('.cnode')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: '源码' })).toHaveCount(0)
  await page.getByRole('tab', { name: '文档' }).click()
  await expect(page.locator('.md-meta')).toContainText('发布检查')
  await page.getByRole('button', { name: 'references/checklist.md' }).click()
  await expect(page.getByLabel('Markdown 源码')).toContainText('发布检查清单')
  await page.getByRole('link', { name: '运行记录' }).click()
  await page.getByLabel('按 Run、Flow、状态或目录筛选').fill('verify')
  await expect(page.getByText('2 / 4 条记录')).toBeVisible()
  await page.getByLabel('按 Run、Flow、状态或目录筛选').fill('')
  await page.getByRole('link', { name: 'verify-003', exact: true }).click()
  await expect(page.locator('[data-status="failed"]').first()).toBeVisible()
  // 详情分流转图与节点执行两类记录：命令节点在节点执行页直接给出标准错误。
  await expect(page.getByRole('tab', { name: 'Flow 流转' })).toBeVisible()
  await page.getByRole('tab', { name: '节点执行' }).click()
  await page.getByRole('button', { name: /校验发布清单/ }).click()
  await expect(page.locator('pre.text-destructive')).toContainText('版本号与 CHANGELOG')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'verify-003' })).toBeVisible()
  // 路由记录把节点开始与节点结束排在一起，点开看当时的入参与提交。
  await page.getByRole('tab', { name: 'Flow 流转' }).click()
  const records = page.locator('table').last()
  await expect(page.getByRole('heading', { name: '路由记录' })).toBeVisible()
  const dialog = page.getByRole('dialog')
  await records.locator('tbody tr').filter({ hasText: '开始' }).first().getByRole('button', { name: /查看节点开始/ }).click()
  await expect(dialog).toContainText('节点开始')
  await expect(dialog).toContainText('入参')
  await expect(dialog).toContainText('进入方式')
  await page.getByLabel('关闭').click()
  await records.locator('tbody tr').filter({ hasText: '结束' }).first().getByRole('button', { name: /查看节点结束/ }).click()
  await expect(dialog).toContainText('节点结束')
  await expect(dialog).toContainText('提交的结果')
  await page.getByLabel('关闭').click()
  // 演示数据带节点会话轨迹与路由判定，直接渲染轨迹查看器。
  await page.goto(base + '#/runs/review-001')
  const decisions = page.locator('table').last().locator('tbody tr').filter({ hasText: '判定' })
  await expect(decisions.first()).toBeVisible()
  await decisions.first().getByRole('button', { name: /查看路由判定/ }).click()
  await expect(dialog).toContainText('路由判定')
  await expect(dialog).toContainText('去向')
  await page.getByLabel('关闭').click()
  await page.getByRole('tab', { name: '节点执行' }).click()
  await page.getByRole('button', { name: /分析任务/ }).click()
  await expect(page.locator('.trajectory-host')).toBeVisible()
  await expect(page.locator('[data-kind="user"]').first()).toBeVisible()
  expect(paths.every((url) => url.startsWith(base))).toBe(true)
  expect(paths.some((url) => url.includes('/api/'))).toBe(false)
})

test('窄屏不产生横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 })
  await page.goto('http://127.0.0.1:14484/dist/')
  for (const path of [
    '#/flows',
    '#/flows/release-check/edit',
    '#/runs',
    '#/runs/review-001',
    '#/runs/review-001?tab=nodes&node=nr-review-1',
  ]) {
    await page.goto('http://127.0.0.1:14484/dist/' + path)
    await expect(page.locator('main').first()).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390)
  }
})
