/**
 * 主场景：真实 Web + 真实 ursi-server + 真实 Pi CLI。
 * 除登录外全部在浏览器完成：发布资源、执行器、工作包 r1，派 A/B 两单，
 * 发布 r2 后旧单仍显示 r1，两单各执行一次，A 通过 v1，B 退回后提交 v2 并通过，
 * 最后用刷新与深链核对文件、退回意见、通过版本与清单状态。
 *
 * 只有模型是模拟的：本机固定回复端点。执行器、工作数据与验收接口都是真实的。
 */
import { randomBytes } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { mainApi } from '../fixtures/api'
import { readModelRequests, summarizeUserMessage, userText, writeEvidence } from '../fixtures/evidence'
import { readRuntime } from '../fixtures/runtime'
import {
  ACCEPTANCE1, ACCEPTANCE2, GUIDE1, GUIDE2, MODEL_ANSWER, SOP1, SOP2,
  escapeRegExp, login, selectRevision, waitForItemPage,
} from './support'

test.describe('双单办理与验收', () => {
  test('浏览器发布定义、派两张单、执行、交付、退回重交与按版本验收', async ({ page }) => {
    test.setTimeout(12 * 60_000)
    const runtime = readRuntime()
    const api = mainApi()
    const noteA = `ticket-A-${randomBytes(4).toString('hex')}`
    const noteB = `ticket-B-${randomBytes(4).toString('hex')}`
    const reviewComment = `请补充 ${noteB} 的复核结论与回执编号`
    const reportA = `${noteA}：已复核回执缺失原因，见附件说明`
    const reportB1 = `${noteB}：初稿，尚未补齐复核结论`
    const reportB2 = `${noteB}：已补齐复核结论与回执编号 ${randomBytes(2).toString('hex')}`
    const nav = page.getByRole('navigation', { name: '主导航' })

    await login(page, runtime.token)
    // 关闭 Flow 与来源后这两组入口应收起。
    await expect(nav.getByRole('link', { name: '工作清单', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: '外部来源', exact: true })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Flow 包', exact: true })).toHaveCount(0)
    await expect(page.getByText('暂无工作项')).toBeVisible()

    // 第一步：在浏览器发布提示词、引用它的本地 Agent 执行器、绑定该执行器的工作包 r1。
    await nav.getByRole('link', { name: '资源库', exact: true }).click()
    await page.getByRole('link', { name: '新建资源' }).click()
    await page.getByLabel('资源 ID', { exact: true }).fill('guide')
    await page.getByLabel('资源类型').selectOption({ label: '提示词' })
    await page.getByLabel('资源内容').fill(GUIDE1)
    await page.getByRole('button', { name: '发布资源' }).click()
    await expect(page).toHaveURL(/\/resources\/guide\/revisions\/1$/)
    await expect(page.getByRole('heading', { name: 'guide v1' })).toBeVisible()

    await nav.getByRole('link', { name: '执行器', exact: true }).click()
    await page.getByRole('link', { name: '新建执行器' }).click()
    await page.getByLabel('执行器 ID', { exact: true }).fill('assistant')
    await page.getByLabel('执行器类型').selectOption({ label: 'Agent' })
    await page.getByLabel('执行环境').selectOption({ label: '本地 Pi Agent' })
    await page.getByRole('button', { name: '添加执行器资源' }).click()
    await page.getByLabel('资源 ID', { exact: true }).selectOption('guide')
    await selectRevision(page, '资源版本', 1)
    await page.getByRole('button', { name: '发布执行器' }).click()
    await expect(page).toHaveURL(/\/executors\/assistant\/revisions\/1$/)

    await nav.getByRole('link', { name: '工作包', exact: true }).click()
    await page.getByRole('link', { name: '新建工作包' }).click()
    await page.getByLabel('工作包 ID', { exact: true }).fill('triage')
    await page.getByLabel('SOP', { exact: true }).fill(SOP1)
    await page.getByLabel('验收标准', { exact: true }).fill(ACCEPTANCE1)
    await page.getByLabel('必交文件（每行一个文件名）').fill('report.txt')
    await page.getByRole('button', { name: '添加输入字段' }).click()
    await page.getByLabel('输入字段名', { exact: true }).fill('note')
    await page.getByLabel('动作名称', { exact: true }).fill('inspect')
    await page.getByLabel('执行器 ID', { exact: true }).selectOption('assistant')
    await selectRevision(page, '执行器版本', 1)
    await page.getByRole('button', { name: '发布工作包' }).click()
    await expect(page).toHaveURL(/\/packages\/triage\/revisions\/1$/)
    await expect(page.getByText('assistant v1')).toBeVisible()

    // 第二步：用 r1 派 A、B 两单，填写不同编号。
    const dispatch = async (note: string) => {
      await page.goto('/items/new?package=triage&revision=1')
      await expect(page.getByRole('heading', { name: 'triage v1' })).toBeVisible()
      await expect(page.getByText(SOP1)).toBeVisible()
      await page.getByLabel('note', { exact: true }).fill(note)
      await page.getByRole('button', { name: '创建待办理工作项' }).click()
      const id = await waitForItemPage(page)
      await expect(page.getByRole('heading', { name: 'triage v1' })).toBeVisible()
      await expect(page.getByText(`单号：${id}`)).toBeVisible()
      await expect(page.getByText('工作项状态：待办理')).toBeVisible()
      return id
    }
    const idA = await dispatch(noteA)
    const idB = await dispatch(noteB)
    expect(idA).not.toBe(idB)

    // 发布 r2：提示词、执行器与工作包都出新版，SOP 与验收标准也改。
    await page.goto('/resources/guide/revisions/1/edit')
    await page.getByLabel('资源内容').fill(GUIDE2)
    await page.getByRole('button', { name: '发布新版' }).click()
    await expect(page).toHaveURL(/\/resources\/guide\/revisions\/2$/)

    await page.goto('/executors/assistant/revisions/1/edit')
    await selectRevision(page, '资源版本', 2)
    await page.getByRole('button', { name: '发布新版' }).click()
    await expect(page).toHaveURL(/\/executors\/assistant\/revisions\/2$/)

    await page.goto('/packages/triage/revisions/1/edit')
    await page.getByLabel('SOP', { exact: true }).fill(SOP2)
    await page.getByLabel('验收标准', { exact: true }).fill(ACCEPTANCE2)
    await selectRevision(page, '执行器版本', 2)
    await page.getByRole('checkbox', { name: /我已核对动作资源和输入输出声明/ }).check()
    await page.getByRole('button', { name: '发布新版' }).click()
    await expect(page).toHaveURL(/\/packages\/triage\/revisions\/2$/)

    // 旧单仍显示 r1，不串新版材料。
    for (const [id, note] of [[idA, noteA], [idB, noteB]] as const) {
      await page.goto(`/items/${id}`)
      await expect(page.getByRole('heading', { name: 'triage v1' })).toBeVisible()
      await expect(page.getByText(`"note": "${note}"`)).toBeVisible()
      await expect(page.locator('section', { hasText: '开单时的 SOP' }).getByText(SOP1)).toBeVisible()
      await expect(page.getByText(SOP2)).toHaveCount(0)
      await expect(page.getByText(ACCEPTANCE2)).toHaveCount(0)
      await expect(page.getByText('inspect → assistant v1（本地 Agent） · guide v1')).toBeVisible()
    }
    await page.goto('/items')
    for (const id of [idA, idB]) {
      const row = page.getByRole('link', { name: new RegExp(escapeRegExp(id)) })
      await expect(row).toContainText('triage')
      await expect(row).toContainText('v1')
    }

    // 第三步：两单各执行一次，能查到输出且业务状态仍为办理中。
    const execute = async (id: string) => {
      await page.goto(`/items/${id}`)
      await page.getByLabel('经办人', { exact: true }).fill('Lin')
      await page.getByRole('button', { name: '开始办理' }).click()
      await expect(page.getByText('工作项状态：办理中')).toBeVisible()
      await page.getByRole('tab', { name: '办理' }).click()
      await page.getByRole('button', { name: '执行一次' }).click()
      const panel = page.getByRole('tabpanel', { name: '执行记录' })
      await expect(panel).toContainText(MODEL_ANSWER, { timeout: 180_000 })
      await expect(panel).toContainText('执行成功')
      await expect(page.getByText('工作项状态：办理中')).toBeVisible()
    }
    await execute(idA)
    await execute(idB)

    // 第四步：A 提交 v1 并通过。
    const detailA = await api.item(idA)
    const detailB = await api.item(idB)
    expect(detailA.attempts).toHaveLength(1)
    expect(detailB.attempts).toHaveLength(1)
    const attemptA = detailA.attempts[0]
    const attemptB = detailB.attempts[0]
    expect(attemptA.status).toBe('succeeded')
    expect(attemptA.output?.trim()).toBe(MODEL_ANSWER)

    await page.goto(`/items/${idA}`)
    await page.getByRole('tab', { name: '交付与验收' }).click()
    await page.getByLabel(/文件正文：report\.txt/).fill(reportA)
    await page.getByRole('checkbox', { name: new RegExp(escapeRegExp(attemptA.id)) }).check()
    await page.getByRole('button', { name: '提交交付' }).click()
    await expect(page.getByText('工作项状态：待验收')).toBeVisible()
    await page.getByLabel('验收人', { exact: true }).fill('Chen')
    await page.getByRole('button', { name: '通过', exact: true }).click()
    await expect(page.getByText('工作项状态：已交付')).toBeVisible()
    await expect(page.getByRole('link', { name: '第 1 版（已通过）' })).toBeVisible()

    // B 提交 v1，附理由退回，修订后在原单提交 v2 并通过。
    await page.goto(`/items/${idB}`)
    await page.getByRole('tab', { name: '交付与验收' }).click()
    await page.getByLabel(/文件正文：report\.txt/).fill(reportB1)
    await page.getByRole('checkbox', { name: new RegExp(escapeRegExp(attemptB.id)) }).check()
    await page.getByRole('button', { name: '提交交付' }).click()
    await expect(page.getByText('工作项状态：待验收')).toBeVisible()
    await page.getByLabel('验收人', { exact: true }).fill('Chen')
    await page.getByLabel('验收意见').fill(reviewComment)
    await page.getByRole('button', { name: '退回', exact: true }).click()
    await expect(page.getByText('工作项状态：办理中')).toBeVisible()
    await expect(page.getByText(reviewComment)).toBeVisible()

    await page.getByRole('tab', { name: '交付与验收' }).click()
    await expect(page.getByText('第 1 版被退回 · Chen')).toBeVisible()
    await page.getByLabel(/文件正文：report\.txt/).fill(reportB2)
    await page.getByRole('checkbox', { name: new RegExp(escapeRegExp(attemptB.id)) }).check()
    await page.getByRole('button', { name: '提交交付' }).click()
    await expect(page.getByText('工作项状态：待验收')).toBeVisible()
    await page.getByLabel('验收人', { exact: true }).fill('Chen')
    await page.getByRole('button', { name: '通过', exact: true }).click()
    await expect(page.getByText('工作项状态：已交付')).toBeVisible()
    await expect(page.getByRole('link', { name: '第 2 版（已通过）' })).toBeVisible()

    // 刷新与深链：A v1、B v1、B v2 分别核对文件、退回意见与通过版本。
    await page.goto(`/items/${idA}/deliveries/1`)
    await expect(page.getByText(reportA)).toBeVisible()
    await expect(page.getByRole('heading', { name: '通过 · Chen' })).toBeVisible()
    await expect(page.getByRole('link', { name: '第 1 版（已通过）' })).toBeVisible()
    await page.reload()
    await expect(page.getByText(reportA)).toBeVisible()

    await page.goto(`/items/${idB}/deliveries/1`)
    await expect(page.getByText(reportB1)).toBeVisible()
    await expect(page.getByRole('heading', { name: '退回 · Chen' })).toBeVisible()
    await expect(page.getByText(reviewComment)).toBeVisible()
    await expect(page.getByRole('button', { name: '通过', exact: true })).toHaveCount(0)

    await page.goto(`/items/${idB}/deliveries/2`)
    await expect(page.getByText(reportB2)).toBeVisible()
    await expect(page.getByRole('heading', { name: '通过 · Chen' })).toBeVisible()
    await expect(page.getByRole('link', { name: '第 2 版（已通过）' })).toBeVisible()

    await page.goto(`/items/${idB}/deliveries/9`)
    await expect(page.getByText('交付版本不存在。')).toBeVisible()

    // 清单状态：两张单都在已交付，待验收为空。
    await page.goto('/items?status=delivered')
    await expect(page.getByRole('link', { name: new RegExp(escapeRegExp(idA)) })).toContainText('已交付')
    await expect(page.getByRole('link', { name: new RegExp(escapeRegExp(idB)) })).toContainText('已交付')
    await page.goto('/items?status=review')
    await expect(page.getByText('暂无待验收工作项')).toBeVisible()

    // 服务端事实与模型请求取证。
    const finalA = await api.item(idA)
    const finalB = await api.item(idB)
    expect(finalA.status).toBe('delivered')
    expect(finalA.acceptedVersion).toBe(1)
    expect(finalA.revision).toBe(1)
    expect(finalA.packageSnapshot.sop).toBe(SOP1)
    expect(finalA.deliveries.map(delivery => delivery.version)).toEqual([1])
    expect(finalB.status).toBe('delivered')
    expect(finalB.acceptedVersion).toBe(2)
    expect(finalB.revision).toBe(1)
    expect(finalB.deliveries.map(delivery => delivery.version)).toEqual([1, 2])
    expect(finalB.deliveries[0].review).toEqual({ decision: 'reject', reviewer: 'Chen', comment: reviewComment })
    expect(finalB.deliveries[1].files['report.txt']).toBe(reportB2)

    const requests = readModelRequests(runtime.modelLog)
    expect(requests).toHaveLength(2)
    const users = requests.map(userText)
    expect(users[0]).toContain('inspect')
    expect(users[0]).toContain(SOP1)
    expect(users[0]).toContain(GUIDE1)
    expect(users[0]).toContain(noteA)
    expect(users[0]).not.toContain(GUIDE2)
    expect(users[0]).not.toContain(noteB)
    expect(users[1]).toContain(noteB)
    expect(users[1]).toContain(GUIDE1)
    expect(users[1]).not.toContain(GUIDE2)
    expect(users[1]).not.toContain(noteA)

    writeEvidence('main-scenario.json', {
      scenario: '主场景：双单办理与验收',
      scope: '真实 Web（构建产物 + 同源代理）+ 真实 ursi-server + 真实 Pi CLI；模拟的是模型，不是执行器、工作数据或验收接口',
      modelEndpoint: runtime.modelUrl,
      tickets: {
        A: {
          itemId: idA, note: noteA, package: 'triage', packageRevision: finalA.revision,
          attemptId: attemptA.id, attemptStatus: attemptA.status, attemptOutput: attemptA.output?.trim(),
          deliveryVersions: finalA.deliveries.map(delivery => delivery.version),
          acceptedVersion: finalA.acceptedVersion, finalStatus: finalA.status,
        },
        B: {
          itemId: idB, note: noteB, package: 'triage', packageRevision: finalB.revision,
          attemptId: attemptB.id, attemptStatus: attemptB.status, attemptOutput: attemptB.output?.trim(),
          deliveryVersions: finalB.deliveries.map(delivery => delivery.version),
          reviews: finalB.deliveries.map(delivery => delivery.review),
          acceptedVersion: finalB.acceptedVersion, finalStatus: finalB.status,
        },
      },
      model: {
        requestCount: requests.length,
        requests: requests.map((request, index) => ({
          index, model: request.model, stream: request.stream,
          userMessage: summarizeUserMessage(users[index]),
        })),
      },
    })
  })
})
