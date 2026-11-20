import { test, expect } from '@playwright/test'
for (const width of [320, 390, 1280])
  test(`列表、筛选和详情深链 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/sandboxes')
    await expect(page.getByText('演示数据')).toBeVisible()
    await page.getByRole('button', { name: '创建沙箱' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByLabel('镜像')).toBeVisible()
    await page.getByRole('tab', { name: 'JSON 编辑' }).click()
    await expect(page.getByLabel('SandboxSpec JSON')).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    const links = page.getByRole('link', { name: /^查看 / })
    await expect(links).toHaveCount(6)
    if (width >= 768)
      await expect(page.getByRole('table', { name: '实例列表' })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.getByRole('button', { name: /运行中/ }).click()
    await expect(links).toHaveCount(3)
    await page.getByRole('button', { name: /全部实例/ }).click()
    await expect(links).toHaveCount(6)
    await page.getByRole('link', { name: '查看 hello-html' }).click()
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'hello-html' }),
    ).toBeVisible()
    const workbench = page.getByRole('region', { name: '端点工作台' })
    const inspector = page.getByRole('complementary', { name: '实例检查' })
    const stage = await workbench.boundingBox()
    const side = await inspector.boundingBox()
    if (width < 1024) expect(side.y).toBeGreaterThan(stage.y + stage.height - 1)
    else expect(side.x).toBeGreaterThan(stage.x + stage.width - 1)
    await inspector.getByRole('button', { name: '实例日志' }).click()
    await expect(page.getByLabel('实例日志输出')).toContainText(
      '[status] running',
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.getByRole('link', { name: '实例列表' }).click()
    await expect(links).toHaveCount(6)
  })
test('快速创建会把表单转换为 SandboxSpec JSON', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: true } }),
  )
  await page.route('**/api/v1/sandboxes', async (r) => {
    if (r.request().method() === 'POST') {
      expect(r.request().postDataJSON()).toEqual({
        image: 'node:22',
        command: ['npm', 'start'],
        labels: { name: 'quick-web' },
        memory_mb: 512,
        cpus: 2,
      })
      return r.fulfill({
        status: 202,
        json: {
          id: 'a'.repeat(32),
          spec: {
            image: 'node:22',
            command: ['npm', 'start'],
            labels: { name: 'quick-web' },
            memory_mb: 512,
            cpus: 2,
          },
          resource: { generation: 1, data_generation: 1 },
          status: 'preparing',
          operation: { kind: 'create' },
          retired: [],
          revision: 1,
          endpoints: [],
          error: null,
        },
      })
    }
    return r.fulfill({ json: { sandboxes: [] } })
  })
  await page.goto('/sandboxes')
  await page.getByRole('button', { name: '创建沙箱' }).click()
  await page.getByLabel('镜像').fill('node:22')
  await page.getByLabel('名称（可选）').fill('quick-web')
  await page.getByLabel('命令参数（每行一个参数，可选）').fill('npm\nstart')
  await page.getByLabel('内存（MiB）').fill('512')
  await page.getByLabel('CPU').fill('2')
  await page.getByRole('button', { name: '提交创建' }).click()
  await expect(page).toHaveURL(/#\/sandboxes\/[a-f0-9]{32}$/)
})
test('管理员可以选择保留数据重建并提交 Gateway 请求', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: true } }),
  )
  await page.route('**/api/v1/capabilities', (r) =>
    r.fulfill({
      json: {
        driver: 'fake',
        capabilities: {
          rebuild_preserve_data: true,
          rebuild_destroy_data: true,
        },
        tunnel_enabled: false,
      },
    }),
  )
  let rebuildBody
  await page.route(
    '**/api/v1/sandboxes/' + 'a'.repeat(32) + '/rebuild',
    async (r) => {
      rebuildBody = r.request().postDataJSON()
      return r.fulfill({
        status: 202,
        json: {
          id: 'a'.repeat(32),
          spec: {
            image: 'node:22',
            labels: { name: 'rebuild-web' },
            cpus: 1,
            memory_mb: 256,
          },
          resource: { generation: 2, data_generation: 1 },
          status: 'preparing',
          operation: { kind: 'rebuild', preserve_data: true },
          retired: [],
          revision: 2,
          endpoints: [],
          error: null,
        },
      })
    },
  )
  await page.route('**/api/v1/sandboxes/' + 'a'.repeat(32), (r) =>
    r.fulfill({
      json: {
        id: 'a'.repeat(32),
        spec: {
          image: 'node:22',
          labels: { name: 'rebuild-web' },
          cpus: 1,
          memory_mb: 256,
        },
        resource: { generation: 1, data_generation: 1 },
        status: 'running',
        operation: null,
        endpoints: [],
        error: null,
        revision: 1,
      },
    }),
  )
  await page.goto('/sandboxes/' + 'a'.repeat(32))
  const more = page.getByRole('button', { name: '更多操作' })
  const choose = async () => {
    await more.click()
    await page.getByRole('menuitem', { name: '保留数据重建' }).click()
  }
  await choose()
  const confirm = page.getByRole('alertdialog', { name: '保留数据重建沙箱' })
  await expect(confirm.getByRole('button', { name: '取消' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(more).toBeFocused()
  expect(rebuildBody).toBeUndefined()
  await choose()
  await confirm.getByRole('button', { name: '确认重建' }).click()
  await expect.poll(() => rebuildBody).toEqual({ preserve_data: true })
  await expect(page.getByText('Gateway 正在处理：rebuild')).toBeVisible()
})
test('Gateway 失败时显示错误，重试后识别空列表', async ({ page }) => {
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway' } }),
  )
  let first = true
  await page.route('**/api/v1/sandboxes', (r) => {
    const status = first ? 503 : 200
    first = false
    return r.fulfill({ status, json: { sandboxes: [] } })
  })
  await page.goto('/sandboxes')
  await expect(page.getByRole('status')).toContainText('Gateway 暂不可用')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByRole('status')).toHaveText('暂无沙箱实例')
})
