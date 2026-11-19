/**
 * 移动视口：抽屉进清单、打开待审报告、退回、重读旧版。
 *
 * 待审材料用真实 HTTP 接口准备（真实 ursi-server、真实令牌），
 * 四个目标动作全部在浏览器里完成；没有 page.route 替身。
 */
import { randomBytes } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { mainApi } from '../fixtures/api'
import { writeEvidence } from '../fixtures/evidence'
import { readRuntime } from '../fixtures/runtime'
import { escapeRegExp, login, viaDrawer } from './support'

const PACKAGE = 'mobile-check'
const REPORT = 'MOBILE-REPORT-v1：移动端待审报告，需核对工单编号'
const COMMENT = '移动端退回：请补充核对依据'

test.describe('移动视口验收', () => {
  test('从抽屉进清单、打开待审报告、退回并重读旧版', async ({ page }) => {
    test.setTimeout(4 * 60_000)
    const runtime = readRuntime()
    const api = mainApi()
    const note = `ticket-M-${randomBytes(3).toString('hex')}`

    // 准备：发布执行器与工作包，派一张单、开始办理并提交第 1 版。
    await api.publish('executors', { id: 'mobile-agent', kind: 'agent', environment: 'local' })
    await api.publish('packages', {
      id: PACKAGE, sop: 'MOBILE-SOP-核对工单', acceptance: 'MOBILE-ACCEPTANCE-核对工单编号',
      deliverables: ['report.txt'], actions: { inspect: { executor: { id: 'mobile-agent', revision: 1 } } },
    })
    const created = await api.post<{ id: string }>('/items', {
      requestId: note, package: PACKAGE, revision: 1, input: { note },
    })
    await api.post(`/items/${created.id}/start`, { assignee: '移动经办' })
    await api.post(`/items/${created.id}/deliveries`, { files: { 'report.txt': REPORT }, attemptIds: [] })
    expect((await api.item(created.id)).status).toBe('review')

    await login(page, runtime.token)
    const expectNoOverflow = async (label: string) => {
      const sizes = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }))
      expect(sizes.document, `${label} 横向溢出：${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport)
      expect(sizes.body, `${label} 横向溢出：${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport)
    }
    await expectNoOverflow('工作清单')

    // 抽屉进清单：先去工作包目录，再从抽屉回到清单。
    await viaDrawer(page, '工作包')
    await expect(page).toHaveURL(/\/packages$/)
    await viaDrawer(page, '工作清单')
    await expect(page).toHaveURL(/\/items$/)

    // 打开待审报告。
    await page.getByRole('link', { name: '待验收', exact: true }).click()
    await expect(page).toHaveURL(/\/items\?status=review$/)
    const row = page.getByRole('link', { name: new RegExp(escapeRegExp(created.id)) })
    await expect(row).toContainText('待验收')
    await row.click()
    await expect(page.getByRole('heading', { name: `${PACKAGE} v1` })).toBeVisible()
    await expect(page.getByText(`单号：${created.id}`)).toBeVisible()
    await expect(page.getByRole('tab', { name: '交付与验收' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(REPORT)).toBeVisible()
    await expectNoOverflow('待验收详情')

    // 退回。
    await page.getByLabel('验收人', { exact: true }).fill('Chen')
    await page.getByLabel('验收意见').fill(COMMENT)
    await page.getByRole('button', { name: '退回', exact: true }).click()
    await expect(page.getByText('工作项状态：办理中')).toBeVisible()
    await expect(page.getByText(COMMENT)).toBeVisible()

    // 重读旧版：从交付页签进入第 1 版深链，文件与退回意见都还在。
    await page.getByRole('tab', { name: '交付与验收' }).click()
    await page.getByRole('link', { name: '第 1 版（当前）' }).click()
    // 行链接带着清单筛选，交付深链沿用同一个 status。
    await expect(page).toHaveURL(new RegExp(`/items/${escapeRegExp(created.id)}/deliveries/1(\\?status=review)?$`))
    await expect(page.getByText(REPORT)).toBeVisible()
    await expect(page.getByRole('heading', { name: '退回 · Chen' })).toBeVisible()
    await expect(page.getByText(COMMENT)).toBeVisible()
    await expectNoOverflow('旧版交付详情')
    await page.reload()
    await expect(page.getByText(REPORT)).toBeVisible()

    const final = await api.item(created.id)
    expect(final.status).toBe('working')
    expect(final.deliveries).toHaveLength(1)
    expect(final.deliveries[0].review).toEqual({ decision: 'reject', reviewer: 'Chen', comment: COMMENT })

    writeEvidence('mobile-scenario.json', {
      scenario: '移动视口：抽屉进清单、打开待审报告、退回、重读旧版',
      scope: '真实 Web + 真实 ursi-server；待审材料用真实 HTTP 接口准备；没有接口替身',
      viewport: page.viewportSize(),
      itemId: created.id, note, package: PACKAGE, packageRevision: 1,
      deliveryVersions: final.deliveries.map(delivery => delivery.version),
      review: final.deliveries[0].review, finalStatus: final.status,
    })
  })
})
