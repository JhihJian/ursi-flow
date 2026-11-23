import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../../src/shared/api/work-projects'
import { readRuntime } from '../fixtures/runtime'
import { login } from './support'

async function openSidebar(page: Page, desktop: boolean) {
  if (desktop) return page.locator('aside.desktop-sidebar')
  const trigger = page.getByRole('button', { name: '打开导航菜单', includeHidden: true })
  const drawer = page.getByRole('dialog', { name: '工作区导航' })
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await expect(drawer).toBeHidden()
    await trigger.click()
  }
  return drawer
}

async function sidebarLink(page: Page, desktop: boolean, section: '主导航' | '项目树', name: string) {
  return (await openSidebar(page, desktop)).getByRole('navigation', { name: section }).getByRole('link', { name, exact: true })
}

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
  const graph = page.locator('.react-flow')
  await expect(desktop ? graph : page.getByRole('list', { name: '画布列表' })).toBeVisible()
  await addNamed(page, '新建画布', '画布名称', '材料准备')
  await expect(await sidebarLink(page, desktop, '项目树', '材料准备')).toBeVisible()
  if (!desktop) await page.getByRole('dialog', { name: '工作区导航' }).getByRole('button', { name: '关闭', exact: true }).click()
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
  const mapInspector = page.getByRole('complementary', { name: 'Canvas Map 详情' })
  await expect(mapInspector.getByText('前项', { exact: true })).toBeVisible()
  await expect(mapInspector.getByText('后项', { exact: true })).toBeVisible()
  await expect(mapInspector.getByRole('button', { name: '默认画布 → 材料准备' })).toHaveCount(0)
  await destination.getByRole('button', { name: '打开画布' }).click()
  await addNamed(page, '新建任务卡', '任务卡名称', '材料收集')
  await addTodo(page, '收齐样本')
  await addTodo(page, '补客户授权', 'continuous')
  if (desktop) {
    await graph.getByRole('button', { name: '补客户授权的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '上移', exact: true }).click()
  } else {
    await page.getByRole('button', { name: '上移 补客户授权' }).click()
  }
  const cardItems = page.getByRole('list', { name: '卡内 TODO' })
  await expect(cardItems.getByRole('listitem').first()).toContainText('补客户授权')
  await (await sidebarLink(page, desktop, '主导航', 'Todo')).click()
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
  await expect(await sidebarLink(page, desktop, '项目树', '补客户授权 已完成')).toHaveAttribute('aria-current', 'page')
  await (await sidebarLink(page, desktop, '主导航', 'Todo')).click()
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
  await (await sidebarLink(page, desktop, '主导航', 'Canvas Map')).click()
  await expect(destination).toContainText('待开始 1 · 进行中 0 · 已完成 1')
  await page.getByRole('button', { name: '关系', exact: true }).click()
  await mapInspector.getByRole('button', { name: '默认画布 → 材料准备' }).click()
  await mapInspector.getByRole('button', { name: '编辑关系' }).click()
  await expect(page.getByRole('combobox', { name: '后项', exact: true }).locator('option:checked')).toHaveText('材料准备')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.every(path => /^\/api\/v2\/(work-projects|work-items)(\/|$)/.test(path))).toBeTruthy()
})

test('右键按命中对象提供快捷操作，空画布可建卡，删除仍需确认', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', '窄屏用原列表操作')
  const { token, apiBase } = readRuntime()
  const headers = { Authorization: `Bearer ${token}` }
  const result = await request.post(`${apiBase}/api/v2/work-projects`, { headers, data: { name: '快捷操作验收' } })
  expect(result.ok()).toBeTruthy()
  const base = `/work-projects/${(await result.json()).id}`
  await login(page, token)
  await page.goto(`${base}/map`)
  const menu = page.getByRole('menu')
  const action = (name: string) => menu.getByRole('menuitem', { name, exact: true })
  const node = (name: string) => page.locator('.react-flow__node').getByText(name, { exact: true })
  const mapInspector = page.getByRole('complementary', { name: 'Canvas Map 详情' })
  await expect(mapInspector.getByRole('heading', { name: '默认画布' })).toBeVisible()
  await page.locator('.react-flow__pane').click({ position: { x: 60, y: 60 } })
  await expect(mapInspector.getByText('未选中画布或关系')).toBeVisible()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
  await node('默认画布').click({ button: 'right' })
  await expect(action('删除画布')).toBeDisabled()
  await action('打开画布').click()

  const pane = page.locator('.react-flow__pane')
  const canvas = page.getByRole('region', { name: '规划画布' })
  await expect(page.getByText('暂无任务卡', { exact: true }).last()).toBeVisible()
  await expect(canvas.getByRole('complementary')).toHaveCount(0)
  await pane.click({ button: 'right', position: { x: 60, y: 60 } })
  await expect(action('新建任务卡')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  const surface = page.getByRole('group', { name: '画布操作' })
  await expect(surface).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(action('新建任务卡')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByLabel('任务卡名称').fill('准备')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(node('准备')).toBeVisible()
  await addNamed(page, '新建任务卡', '任务卡名称', '交付')
  await node('准备').click()
  await expect(canvas.getByRole('complementary', { name: '准备' })).toBeVisible()
  await node('交付').click({ button: 'right' })
  await action('重命名任务卡').click()
  await expect(page.getByLabel('任务卡名称')).toHaveValue('交付')
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await node('交付').click({ button: 'right' })
  await action('新建 TODO').click()
  await page.getByLabel('标题', { exact: true }).fill('核对结果')
  await page.getByRole('button', { name: '创建 TODO', exact: true }).click()
  const viewport = page.locator('.react-flow__viewport')
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  const previousTransform = await viewport.evaluate(element => (element as HTMLElement).style.transform)
  const todo = page.getByRole('button', { name: '核对结果', exact: true })
  await todo.click({ button: 'right' })
  await expect(action('新建 TODO')).toHaveCount(0)
  await expect(action('移动或移出 TODO')).toBeEnabled()
  await action('打开详情').click()
  const inspector = page.getByRole('complementary', { name: '工作项详情' })
  await expect(inspector.getByLabel('标题')).toHaveValue('核对结果')
  await expect(canvas.getByRole('complementary')).toHaveCount(1)
  await expect.poll(() => viewport.evaluate(element => (element as HTMLElement).style.transform)).toBe(previousTransform)
  await inspector.getByRole('button', { name: '关闭详情' }).click()
  await expect(canvas.getByRole('complementary', { name: '准备' })).toBeVisible()
  await node('交付').click({ button: 'right' })
  await expect(action('删除任务卡')).toBeDisabled()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '新建关系', exact: true }).click()
  await page.getByRole('combobox', { name: '前项', exact: true }).selectOption({ label: '准备' })
  await page.getByRole('combobox', { name: '后项', exact: true }).selectOption({ label: '交付' })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const path = page.locator('path.react-flow__edge-interaction')
  await expect(path).toHaveCount(1)
  const point = await path.evaluate((line: SVGPathElement) => {
    const { x, y } = line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM()!)
    return { x, y }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await action('删除关系').click()
  await expect(path).toHaveCount(1)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(path).toHaveCount(0)
  await expect(canvas.getByRole('complementary')).toHaveCount(0)
  await page.getByRole('button', { name: '画布设置', exact: true }).click()
  await expect(canvas.getByRole('complementary', { name: '画布设置' }).getByRole('button', { name: '重命名画布' })).toBeVisible()
  await page.getByRole('button', { name: '关闭图详情' }).click()
  await expect(canvas.getByRole('complementary')).toHaveCount(0)
})

test('全局侧栏独立展开、选择项目和定位 TODO，刷新后仍能打开对应项目', async ({ page, request }, info) => {
  const { token, apiBase } = readRuntime()
  const headers = { Authorization: `Bearer ${token}` }
  const root = `${apiBase}/api/v2/work-projects`
  async function seed(name: string) {
    const result = await request.post(root, { headers, data: { name } })
    expect(result.ok()).toBeTruthy()
    const { id } = await result.json()
    const read = async (): Promise<Workspace> => (await request.get(`${root}/${id}/workspace`, { headers })).json()
    const snapshot = await read()
    const canvas = snapshot.canvases[0]
    const card = await request.post(`${root}/${id}/commands`, { headers, data: {
      revision: snapshot.project.revision, type: 'createTaskCard', canvasId: canvas.id, name: '交付检查',
    } })
    expect(card.ok()).toBeTruthy()
    const { id: taskCardId } = await card.json()
    const item = await request.post(`${root}/${id}/commands`, { headers, data: {
      revision: (await read()).project.revision, type: 'createItem', taskCardId, title: '确认交付日期',
    } })
    expect(item.ok()).toBeTruthy()
    return { path: `/work-projects/${id}`, canvas: canvas.id, card: taskCardId, item: (await item.json()).id }
  }
  const firstName = `侧栏方案甲-${info.project.name}`
  const secondName = `侧栏方案乙-${info.project.name}`
  const first = await seed(firstName)
  const second = await seed(secondName)
  await login(page, token)
  const desktop = info.project.name === 'desktop'
  const sidebar = await openSidebar(page, desktop)
  const tree = sidebar.getByRole('navigation', { name: '项目树' })
  const todo = sidebar.getByRole('link', { name: 'Todo', exact: true })
  await expect(todo).toHaveAttribute('href', '/work-projects?view=todo')
  await todo.click()
  await expect(page.getByRole('heading', { name: '选择 Todo 项目' })).toBeVisible()
  await page.getByRole('main').getByRole('link', { name: firstName }).click()
  await expect(page).toHaveURL(`${first.path}/todo`)
  await openSidebar(page, desktop)
  await expect(todo).toHaveAttribute('aria-current', 'page')
  const secondBranch = tree.getByRole('listitem').filter({ has: page.getByRole('link', { name: secondName, exact: true }) })
  await secondBranch.getByRole('button', { name: `展开 项目 ${secondName}` }).click()
  await secondBranch.getByRole('button', { name: '展开 画布 默认画布' }).click()
  await secondBranch.getByRole('button', { name: '展开 任务卡 交付检查' }).click()
  await expect(page).toHaveURL(`${first.path}/todo`)
  const leaf = secondBranch.getByRole('link', { name: /确认交付日期/ })
  await leaf.click()
  await expect(page).toHaveURL(`${second.path}/canvases/${second.canvas}?focusItemId=${second.item}&itemId=${second.item}`)
  if (!desktop) await expect(sidebar).toBeHidden()
  await expect(page.getByRole('list', { name: '卡内 TODO' }).locator('[aria-current=true]')).toContainText('确认交付日期')
  await page.reload()
  await openSidebar(page, desktop)
  await expect(leaf).toHaveAttribute('aria-current', 'page')
  await secondBranch.getByRole('link', { name: '交付检查', exact: true }).click()
  await expect(page).toHaveURL(`${second.path}/canvases/${second.canvas}?focusCardId=${second.card}`)
  await (await sidebarLink(page, desktop, '主导航', '工作清单')).click()
  await expect(page).toHaveURL('/work-items')
  await (await sidebarLink(page, desktop, '主导航', 'Canvas Map')).click()
  await expect(page).toHaveURL(`${second.path}/map`)
  await page.goto(`${first.path}/canvases/${first.canvas}?focusItemId=${first.item}`)
  await expect(await sidebarLink(page, desktop, '主导航', 'Todo')).toHaveAttribute('href', `${first.path}/todo`)
  await page.goto(`${first.path}/canvases/removed`)
  await expect(page.getByText('画布不存在', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '返回 Canvas Map' }).click()
  await expect(page).toHaveURL(`${first.path}/map`)
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
  const desktop = info.project.name === 'desktop'
  await (await sidebarLink(page, desktop, '项目树', '第二张画布')).click()
  await addNamed(page, '新建任务卡', '任务卡名称', '归档')
  const targetId = new URL(page.url()).pathname.split('/').at(-1)
  await (await sidebarLink(page, desktop, '项目树', '默认画布')).click()
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
