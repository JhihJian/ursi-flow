/**
 * 来源专项：另起一台配置 json-file 来源的真实 Server。
 * 证明来源列表派工进入同一工作清单，且页面只提供获准动作。
 *
 * 来源配置与工作包由管理员准备（真实 HTTP 接口，同一令牌），
 * 派工与办理在浏览器完成；没有 page.route 替身。
 */
import { test, expect } from '@playwright/test'
import { sourcesApi } from '../fixtures/api'
import { writeEvidence } from '../fixtures/evidence'
import { readRuntime } from '../fixtures/runtime'
import { escapeRegExp, login, waitForItemPage } from './support'

const PACKAGE = 'source-triage'

test.describe('JSON 来源派工', () => {
  test('来源列表派工进入同一清单且只允许固定动作', async ({ page }) => {
    test.setTimeout(4 * 60_000)
    const runtime = readRuntime()
    const api = sourcesApi()

    // 管理员准备：包有两个动作，来源配置只开放 inspect。
    await api.publish('executors', { id: 'source-agent', kind: 'agent', environment: 'local' })
    await api.publish('packages', {
      id: PACKAGE, sop: 'SOURCE-SOP-核对来源材料', acceptance: 'SOURCE-ACCEPTANCE-核对条目材料',
      deliverables: ['report.txt'],
      actions: {
        inspect: { executor: { id: 'source-agent', revision: 1 } },
        review: { executor: { id: 'source-agent', revision: 1 } },
      },
    })

    await login(page, runtime.token)
    const nav = page.getByRole('navigation', { name: '主导航' })
    await expect(nav.getByRole('link', { name: '外部来源', exact: true })).toBeVisible()
    await nav.getByRole('link', { name: '外部来源', exact: true }).click()
    await expect(page).toHaveURL(/\/sources$/)
    await expect(page.getByText('tickets')).toBeVisible()
    await expect(page.getByText('json-file · inspect')).toBeVisible()

    await page.getByRole('link', { name: /tickets/ }).click()
    await expect(page).toHaveURL(/\/sources\/tickets\/items$/)
    await page.getByRole('link', { name: /订单回执缺失/ }).click()
    await expect(page).toHaveURL(/\/sources\/tickets\/items\/T-1$/)
    await expect(page.getByText('未收到回执')).toBeVisible()

    const action = page.getByLabel('固定动作', { exact: true })
    const options = action.locator('option')
    await expect(options).toHaveCount(2)
    await expect(options.nth(1)).toHaveText('inspect')
    await expect(action.locator('option', { hasText: 'review' })).toHaveCount(0)
    await action.selectOption('inspect')
    await page.getByRole('button', { name: '派工', exact: true }).click()
    const id = await waitForItemPage(page)
    await expect(page.getByRole('heading', { name: `${PACKAGE} v1` })).toBeVisible()
    await expect(page.getByText(`单号：${id}`)).toBeVisible()
    await expect(page.getByText('来源：tickets')).toBeVisible()
    await expect(page.getByText('条目：T-1')).toBeVisible()
    await expect(page.getByText('获准动作：inspect')).toBeVisible()

    // 只允许快照里的固定动作：页面不出现 review，动作下拉只有一个选项且不可切换。
    const bindings = page.locator('section', { hasText: '固定动作与执行器' })
    await expect(bindings).toContainText('inspect → source-agent v1（本地 Agent）')
    await expect(bindings).not.toContainText('review')
    await page.getByLabel('经办人', { exact: true }).fill('Lin')
    await page.getByRole('button', { name: '开始办理' }).click()
    await expect(page.getByText('工作项状态：办理中')).toBeVisible()
    // 动作下拉的 label 包着 select，可见文案还会带上选项名，用前缀匹配。
    const chosen = page.getByLabel(/^动作/)
    await expect(chosen.locator('option')).toHaveCount(1)
    await expect(chosen).toHaveValue('inspect')
    await expect(chosen).toBeDisabled()
    await expect(page.getByText('绑定执行器：source-agent v1（本地 Agent）')).toBeVisible()

    // 同一清单：来源派工单出现在工作清单里，来源列照样可读。
    await page.getByRole('link', { name: '返回工作清单' }).click()
    await page.getByRole('link', { name: '办理中', exact: true }).click()
    const row = page.getByRole('link', { name: new RegExp(escapeRegExp(id)) })
    await expect(row).toContainText(PACKAGE)
    await expect(row).toContainText('tickets · T-1 · inspect')
    await expect(row).toContainText('办理中')

    const item = await api.item(id)
    expect(item.source).toEqual({ type: 'connector', provider: 'tickets', itemId: 'T-1', action: 'inspect' })
    expect(Object.keys(item.packageSnapshot.actions)).toEqual(['inspect', 'review'])
    expect(item.input).toEqual({ ticket: 'T-1', symptom: '未收到回执' })

    writeEvidence('sources-scenario.json', {
      scenario: 'JSON 来源列表派工',
      scope: '真实 Web + 真实 ursi-server（URSI_WORK_SOURCES 指向本机 0600 JSON 导出）；没有接口替身',
      provider: 'tickets', sourceItem: 'T-1', itemId: id,
      package: PACKAGE, packageRevision: item.revision,
      allowedAction: 'inspect', snapshotActions: Object.keys(item.packageSnapshot.actions),
      observedSource: item.source, finalStatus: item.status,
    })
  })
})
