import { test, expect } from '@playwright/test'

const image = {
  reference: 'ursi-runtime-browser:local',
  local_id: 'sha256:browser-example',
  registered: {
    bundles: ['pi-execution', 'browser'],
    endpoints: [
      { bundle: 'pi-execution', name: 'ssh', protocol: 'ssh', port: 2222 },
      { bundle: 'browser', name: 'preview', protocol: 'http', port: 8080 },
    ],
    runtime_min_image_level: 2,
  },
}

for (const width of [320, 1280]) {
  test(`能力页区分原子、镜像配方和登记配置 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await page.route('**/console-config.json', (r) =>
      r.fulfill({ json: { mode: 'gateway' } }),
    )
    await page.route('**/api/v1/images', (r) =>
      r.fulfill({
        json: {
          inventory: 'available',
          images: [
            image,
            {
              reference: 'ursi-runtime-pi:local',
              local_id: 'sha256:pi-example',
              registered: null,
            },
            {
              reference: 'custom:next',
              local_id: null,
              registered: { invalid: true },
            },
          ],
        },
      }),
    )
    await page.goto('./#/registry')
    const bundles = page.getByRole('table', { name: '原子 Bundle' })
    await expect(bundles.getByRole('row')).toHaveCount(4)
    await expect(bundles.getByRole('row', { name: /Pi Agent/ })).toContainText(
      '含 Node.js 和 Pi CLI',
    )
    await expect(
      bundles.getByRole('row', { name: /浏览器桌面与 IDE/ }),
    ).not.toContainText('agent_session')
    await expect(bundles).not.toContainText('pi-runtime')
    const images = page.getByRole('table', { name: '镜像与组合能力' })
    const pi = images.getByRole('row', { name: /ursi-runtime-pi/ })
    await expect(pi).toContainText('本机已有')
    await expect(pi).toContainText('未登记')
    await expect(pi).toContainText('agent_session')
    await expect(
      images.getByRole('row', { name: /ursi-runtime-browser/ }),
    ).toContainText('preview')
    const missing = images.getByRole('row', { name: /custom:next/ })
    await expect(missing).toContainText('本机未查到')
    await expect(missing).toContainText('登记组合无效')
    await expect(
      page.getByRole('button', { name: '编辑 Gateway 注册表' }),
    ).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
  })
}

test('查询可重试，管理配置保存后刷新且草稿不参与显示', async ({ page }) => {
  let first = true
  let saved = false
  await page.route('**/console-config.json', (r) =>
    r.fulfill({ json: { mode: 'gateway', manage: true } }),
  )
  await page.route('**/api/v1/images', (r) => {
    const status = first ? 503 : 200
    first = false
    return r.fulfill({
      status,
      json: { inventory: 'available', images: saved ? [image] : [] },
    })
  })
  const registry = { bundles: {}, images: {} }
  await page.route('**/api/v1/registry', (r) => {
    if (r.request().method() === 'PUT') {
      expect(r.request().postDataJSON()).toEqual(registry)
      saved = true
    }
    return r.fulfill({ json: registry })
  })
  await page.goto('./#/registry')
  await expect(page.getByRole('alert')).toContainText('读取镜像清单失败')
  await page.getByRole('button', { name: '刷新镜像' }).click()
  await expect(page.getByRole('main').getByRole('status')).toContainText('暂无本机')
  await page.getByRole('button', { name: '编辑 Gateway 注册表' }).click()
  await expect(page.getByLabel('Gateway registry JSON')).toHaveValue(/bundles/)
  await page.getByLabel('Gateway registry JSON').fill(JSON.stringify(registry))
  await expect(page.getByRole('table', { name: '镜像与组合能力' })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByRole('row', { name: /ursi-runtime-browser/ }),
  ).toBeVisible()
})
