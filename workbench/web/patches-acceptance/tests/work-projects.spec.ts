import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../../src/shared/api/work-projects'
import { readRuntime } from '../fixtures/runtime'
import { login } from './support'

async function addNamed(page: Page, button: string, field: string, name: string) {
  await page.getByRole('button', { name: button, exact: true }).click()
  await page.getByLabel(field, { exact: true }).fill(name)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByLabel(field, { exact: true })).toHaveCount(0)
}

async function addTodo(page: Page, name: string, category = 'one_time') {
  await page.getByRole('button', { name: '新建 TODO', exact: true }).click()
  await page.getByLabel('标题', { exact: true }).fill(name)
  await page.getByLabel('工作说明', { exact: true }).fill(`说明：${name}`)
  await page.getByRole('combobox', { name: '类别', exact: true }).selectOption(category)
  await page.getByRole('button', { name: '创建 TODO', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

test('关闭 Flow：地图打开画布，编辑和定位 TODO，刷新后保留布局与关系', async ({ page, request }, info) => {
  const { token, apiBase } = readRuntime()
  const headers = { Authorization: `Bearer ${token}` }
  const writes: string[] = []
  page.on('request', req => {
    const path = new URL(req.url()).pathname
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) writes.push(path)
  })
  await login(page, token)
  await page.goto('/work-projects')
  const projectName = `客户交付-${info.project.name}`
  await page.getByLabel('项目名称').fill(projectName)
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible()
  const projectPath = new URL(page.url()).pathname.replace(/\/map$/, '')
  const snapshot = async (): Promise<Workspace> => {
    const response = await request.get(`${apiBase}/api/v2${projectPath}/workspace`, { headers })
    expect(response.ok()).toBeTruthy()
    return await response.json()
  }
  const desktop = info.project.name === 'desktop'
  const tree = page.getByRole('navigation', { name: '项目树' })
  const graph = page.locator('.react-flow')
  await expect(desktop ? graph : page.getByRole('list', { name: '画布列表' })).toBeVisible()
  await addNamed(page, '新建画布', '画布名称', '材料准备')
  await expect(tree.getByRole('link', { name: '材料准备' })).toBeVisible()
  const destination = desktop ? graph.locator('.react-flow__node', { hasText: '材料准备' })
    : page.getByRole('list', { name: '画布列表' }).getByRole('listitem').filter({ hasText: '材料准备' })
  if (desktop) {
    const title = destination.locator('.wb-canvas-card-title')
    await graph.getByRole('button', { name: '适应视图' }).click()
    await title.scrollIntoViewIfNeeded()
    const box = (await title.boundingBox())!
    const saved = page.waitForResponse(res => res.url().endsWith('/layout') && res.request().method() === 'PUT', { timeout: 6000 })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 75, box.y + box.height / 2 + 85, { steps: 12 })
    await page.mouse.up()
    expect((await saved).ok()).toBeTruthy()
    const positions = (await snapshot()).layouts.map.positions
    expect(Object.keys(positions)).toHaveLength(2)
    await page.reload()
    expect((await snapshot()).layouts.map.positions).toEqual(positions)
  }
  await page.getByRole('button', { name: '新建关系' }).click()
  await page.getByRole('combobox', { name: '前项', exact: true }).selectOption({ label: '默认画布' })
  await page.getByRole('combobox', { name: '后项', exact: true }).selectOption({ label: '材料准备' })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '默认画布 → 材料准备' })).toBeVisible()
  await destination.getByRole('button', { name: '打开画布' }).click()
  await addNamed(page, '新建任务卡', '任务卡名称', '材料收集')
  await addTodo(page, '收齐样本')
  await addTodo(page, '补客户授权', 'continuous')
  await page.getByRole('button', { name: '上移 补客户授权' }).click()
  const cardItems = page.getByRole('list', { name: '卡内 TODO' })
  await expect(cardItems.getByRole('listitem').first()).toContainText('补客户授权')
  await tree.getByRole('link', { name: '项目 TODO' }).click()
  await page.getByRole('combobox', { name: '类别', exact: true }).selectOption('continuous')
  await expect(page.getByText('显示 1 / 2 项')).toBeVisible()
  await expect(page.getByRole('heading', { name: '全项目状态 · 2 项' })).toBeVisible()
  await page.getByRole('button', { name: /补客户授权/ }).click()
  const inspector = page.getByRole('complementary', { name: '工作项详情' })
  await inspector.getByRole('combobox', { name: '状态', exact: true }).selectOption('completed')
  await inspector.getByRole('button', { name: '保存工作项' }).click()
  await expect(inspector.getByRole('button', { name: '保存工作项' })).toBeDisabled()
  await inspector.getByRole('button', { name: '在画布中定位' }).click()
  await expect(page).toHaveURL(/\/canvases\/.*\?focusItemId=/)
  await expect(cardItems.locator('[aria-current=true]')).toContainText('补客户授权')
  await expect(cardItems.locator('[aria-current=true]')).toContainText('已完成')
  await tree.getByRole('link', { name: '项目 TODO' }).click()
  await expect(page).toHaveURL(/category=continuous/)
  await expect(page.getByText('显示 1 / 2 项')).toBeVisible()
  const placed = (await snapshot()).items[0].item
  const fullDetail = page.getByRole('link', { name: '查看完整详情' })
  await expect(fullDetail).toHaveAttribute('href', `/work-items/${placed.id}`)
  await fullDetail.click()
  await expect(page.getByRole('link', { name: '在画布中定位' })).toBeVisible()
  await expect(page.getByRole('link', { name: '查看本项的生成记录' })).toBeVisible()
  await page.getByRole('link', { name: '在画布中定位' }).click()
  await expect(cardItems.locator('[aria-current=true]')).toContainText('补客户授权')
  await tree.getByRole('link', { name: 'Canvas Map' }).click()
  await expect(destination).toContainText('共 2 项 · 已完成 1 项')
  await expect(page.getByRole('button', { name: '默认画布 → 材料准备' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.every(path => /^\/api\/v2\/(work-projects|work-items)(\/|$)/.test(path))).toBeTruthy()
})

test('全局事项加入、跨画布移动和移出都保留原 ID 与内容修订', async ({ page, request }, info) => {
  const { token, apiBase } = readRuntime()
  const headers = { Authorization: `Bearer ${token}` }
  const root = `${apiBase}/api/v2`
  const title = `已有事项-${info.project.name}`
  const createdItem = await request.post(`${root}/work-items`, { headers, data: { title, description: '保留原说明' } })
  expect(createdItem.ok()).toBeTruthy()
  const original = await createdItem.json()
  const name = `归属验收-${info.project.name}`
  const createdProject = await request.post(`${root}/work-projects`, { headers, data: { name } })
  expect(createdProject.ok()).toBeTruthy()
  const { id } = await createdProject.json()
  const path = `/work-projects/${id}`
  const getPlacement = async () => (await request.get(`${root}/work-items/${original.id}/placement`, { headers })).json()
  await login(page, token)
  await page.goto(`${path}/map`)
  await addNamed(page, '新建画布', '画布名称', '第二张画布')
  const tree = page.getByRole('navigation', { name: '项目树' })
  await tree.getByRole('link', { name: '第二张画布' }).click()
  await addNamed(page, '新建任务卡', '任务卡名称', '归档')
  const targetId = new URL(page.url()).pathname.split('/').at(-1)
  await tree.getByRole('link', { name: '默认画布' }).click()
  await addNamed(page, '新建任务卡', '任务卡名称', '待整理')
  await page.getByRole('button', { name: '加入已有事项' }).click()
  await page.getByRole('combobox', { name: '已有事项' }).selectOption({ label: title })
  await page.getByRole('button', { name: '加入任务卡' }).click()
  await page.getByRole('button', { name: title, exact: true }).click()
  const inspector = page.getByRole('complementary', { name: '工作项详情' })
  await expect(inspector.getByText('默认画布 / 待整理')).toBeVisible()
  await inspector.getByRole('combobox', { name: '目标任务卡' }).selectOption({ label: '归档' })
  await inspector.getByRole('button', { name: '移动工作项' }).click()
  await expect(inspector.getByText('第二张画布 / 归档')).toBeVisible()
  expect(await getPlacement()).toMatchObject({ projectId: id, canvasId: targetId })
  await inspector.getByRole('button', { name: '移出项目' }).click()
  await page.getByRole('button', { name: '确认移出' }).click()
  await expect(inspector.getByText('此工作项已不在当前项目中', { exact: false })).toBeVisible()
  expect(await getPlacement()).toBeNull()
  expect(await (await request.get(`${root}/work-items/${original.id}`, { headers })).json()).toEqual(original)

  await page.getByRole('button', { name: '重命名项目' }).click()
  await page.getByRole('dialog').getByLabel('项目名称').fill(`${name}已整理`)
  await page.getByRole('button', { name: '保存项目名称' }).click()
  await expect(page.getByRole('heading', { name: `${name}已整理` })).toBeVisible()
  await page.getByRole('button', { name: '删除项目' }).click()
  await page.getByRole('button', { name: '确认删除项目' }).click()
  await expect(page).toHaveURL(/\/work-projects$/)
  await expect(page.getByRole('link', { name: `${name}已整理` })).toHaveCount(0)
})
