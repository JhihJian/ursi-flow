import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { WorkApi, type Sop } from '../fixtures/api'
import { digest, writeEvidence } from '../fixtures/evidence'
import { restartServer } from '../fixtures/process'
import { readRuntime } from '../fixtures/runtime'
import {
  createWorkspace, downloadReceipt, executeAgain, executeOnce, expectNoOverflow,
  login, openNewWorkspace, openNewWorkspaceFromPackagesEntry, openWorkspaceRow, openWorkspaces,
  previewReceipt, publishSop, saveRequirement, uploadMaterial,
} from './support'

const MATERIAL_NAME = '材料.md'
const DEFAULT_SOP: Sop = {
  id: 'receipt',
  revision: 1,
  executor: 'echo',
  config: { title: '材料接收回执' },
}

function utf8Size(text: string) {
  return Buffer.byteLength(text, 'utf8')
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从回执的 Markdown 表格里取出某个角色的文件大小与内容摘要。 */
function materialRow(receipt: string, role: string) {
  const pattern = new RegExp(`\\| .+（${role}） \\| ${escapeRegExp(MATERIAL_NAME)} \\| (\\d+) 字节 \\| FNV-1a64 ([0-9a-f]{16}) \\|`)
  const match = pattern.exec(receipt)
  if (!match) throw new Error(`回执里没有角色 ${role} 的材料行：\n${receipt}`)
  return { size: Number(match[1]), hash: match[2] }
}

/** 回执第一行是 SOP 标题。 */
function receiptTitle(receipt: string) {
  const match = /^# (.+)$/m.exec(receipt)
  if (!match) throw new Error(`回执没有标题行：\n${receipt}`)
  return match[1]!.trim()
}

test('工作包不绑 SOP、独立发布后再换版执行，并保留同名隔离与重启', async ({ page }, testInfo) => {
  const runtime = readRuntime()
  const api = new WorkApi(runtime)
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const requirementA = `甲单 ${suffix}：核对材料回执`
  const requirementA2 = `甲单 ${suffix}：核对材料回执（修订）`
  const requirementB = `乙单 ${suffix}：核对同文件名材料的回执`
  const publishedTitle = `交接回执 ${suffix}`
  const findingA = `# 甲单线索\n\n线索编号 A-${suffix}\n内容只属于甲单。\n`
  const sourceA = `# 甲单源码包\n\n打包时间 A-${suffix}\n`
  const findingB = `# 乙单线索\n\n线索编号 B-${suffix}\n内容只属于乙单，与甲单文件名相同。\n`
  const sourceB = `# 乙单源码包\n\n打包时间 B-${suffix}\n`
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  // 类型目录只公布推荐 SOP 引用；创建表单和草稿都不绑定 SOP。
  const types = await api.types()
  expect(types).toEqual([{
    id: 'finding-report',
    name: '单条线索报告',
    roles: [{ id: 'finding', label: 'Finding' }, { id: 'source', label: '源码包' }],
    sop: { id: 'receipt', revision: 1 },
  }])

  await login(page, runtime.token)

  // 从旧 /packages/new 入口进入，真正的新建组件在 /workspaces/new。
  await openNewWorkspaceFromPackagesEntry(page)
  await expect(page.getByRole('combobox', { name: 'SOP 版本' })).toHaveCount(0)
  await expect(page.getByLabel('SOP 标识')).toHaveCount(0)
  await expect(page.getByLabel('回执标题')).toHaveCount(0)
  await expectNoOverflow(page)

  const idA = await createWorkspace(page, requirementA)
  // 包级 SOP 已被移除：创建接口拒绝该字段，详情也没有顶层 sop。
  const rejectedSopCreate = await api.attemptCreate({
    typeId: 'finding-report',
    requirement: `带包级 SOP 的请求 ${suffix}`,
    sop: { id: 'receipt', revision: 1 },
  })
  expect(rejectedSopCreate.status).toBeGreaterThanOrEqual(400)
  expect(rejectedSopCreate.status).toBeLessThan(500)
  let detailA = await api.get(idA)
  // 建包阶段只有类型、需求和材料，详情没有包级 sop 字段。
  expect(detailA).not.toHaveProperty('sop')
  expect(detailA.ready).toBe(false)
  expect(detailA.frozen).toBe(false)
  expect(detailA.attempts).toEqual([])
  await expect(page.getByText('工作包已冻结')).toHaveCount(0)
  await expectNoOverflow(page)

  // 准备材料前先修订需求；需求与材料齐备后 ready 为真，但仍未执行、未冻结。
  await saveRequirement(page, requirementA2)
  await uploadMaterial(page, 'Finding', MATERIAL_NAME, findingA)
  await uploadMaterial(page, '源码包', MATERIAL_NAME, sourceA)
  detailA = await api.get(idA)
  expect(detailA.requirement).toBe(requirementA2)
  expect(detailA.ready).toBe(true)
  expect(detailA.frozen).toBe(false)
  expect(detailA).not.toHaveProperty('sop')
  expect(detailA.materials).toEqual([
    { role: 'finding', name: MATERIAL_NAME, size: utf8Size(findingA) },
    { role: 'source', name: MATERIAL_NAME, size: utf8Size(sourceA) },
  ])

  // 材料按角色名落盘，不使用上传文件名，因此两张单的同名文件互不覆盖。
  const filesRoot = path.join(runtime.dataDir, 'work', 'workspace-files')
  const roleFiles = readdirSync(path.join(filesRoot, idA)).sort()
  expect(roleFiles).toEqual(['finding', 'source'])
  expect(readFileSync(path.join(filesRoot, idA, 'finding'), 'utf8')).toBe(findingA)
  expect(readFileSync(path.join(filesRoot, idA, 'source'), 'utf8')).toBe(sourceA)
  await expectNoOverflow(page)

  // 第一次执行显式使用内置默认版本 receipt@1，回执标题来自该版本。
  await executeOnce(page, 'receipt@1')
  await expect(page.getByText('1 次执行')).toBeVisible()
  await expectNoOverflow(page)
  detailA = await api.get(idA)
  expect(detailA.frozen).toBe(true)
  expect(detailA.attempts).toHaveLength(1)
  expect(detailA.attempts[0]!.status).toBe('succeeded')
  expect(detailA.attempts[0]!.sop).toEqual(DEFAULT_SOP)
  const attemptA1 = detailA.attempts[0]!.id

  const serverA1 = await api.receipt(idA, attemptA1)
  const previewA1 = await previewReceipt(page, attemptA1, serverA1.body)
  const downloadedA1 = await downloadReceipt(page, attemptA1)
  expect(downloadedA1.download.suggestedFilename()).toBe('receipt.md')
  expect(downloadedA1.text).toBe(previewA1)
  expect(receiptTitle(previewA1)).toBe(DEFAULT_SOP.config.title)
  expect(previewA1).toContain('receipt@1')
  expect(previewA1).toContain(requirementA2)
  expect(materialRow(previewA1, 'finding').size).toBe(utf8Size(findingA))
  expect(materialRow(previewA1, 'source').size).toBe(utf8Size(sourceA))
  const apiDownloadA1 = await api.receipt(idA, attemptA1, true)
  expect(apiDownloadA1.contentType).toContain('text/plain')
  expect(apiDownloadA1.disposition).toContain('attachment')
  expect(apiDownloadA1.disposition).toContain('receipt.md')
  expect(apiDownloadA1.body).toBe(previewA1)

  // 从 /sops/new 用真实表单独立发布同名 SOP 新修订，不碰任何工作包。
  const beforePublishDetail = await api.get(idA)
  const beforePublishReceipt = await api.receipt(idA, attemptA1)
  const published = await publishSop(page, 'receipt', publishedTitle)
  // 同一标识追加新修订；其他项目轮次已验证过的旧修订不影响本次选择。
  expect(published.revision).toBeGreaterThanOrEqual(2)
  await expectNoOverflow(page)
  const publishedSop = await api.sop('receipt', published.revision)
  expect(publishedSop).toEqual({
    id: 'receipt',
    revision: published.revision,
    executor: 'echo',
    config: { title: publishedTitle },
  })
  const catalogAfterPublish = await api.sops()
  expect(catalogAfterPublish).toEqual(expect.arrayContaining([DEFAULT_SOP, publishedSop]))
  expect(catalogAfterPublish.filter(sop => sop.id === 'receipt' && sop.revision === published.revision)).toHaveLength(1)
  const afterPublishDetail = await api.get(idA)
  expect(afterPublishDetail).toEqual(beforePublishDetail)

  // 回到同一包的结果页显式换版重跑：新尝试保存新 SOP，旧回执保持不变。
  await page.goto(`/workspaces/${idA}/result`)
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptA1}` })).toBeVisible()
  await executeAgain(page, `receipt@${published.revision}`)
  await expectNoOverflow(page)
  detailA = await api.get(idA)
  expect(detailA.frozen).toBe(true)
  expect(detailA.attempts).toHaveLength(2)
  expect(detailA.attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'succeeded'])
  expect(detailA.attempts[0]!.sop).toEqual(DEFAULT_SOP)
  expect(detailA.attempts[1]!.sop).toEqual(publishedSop)
  const attemptA2 = detailA.attempts[1]!.id
  await expect(page.locator('ol li').filter({ hasText: `${DEFAULT_SOP.config.title} · receipt v1` })).toHaveCount(1)
  await expect(page.locator('ol li').filter({ hasText: `${publishedTitle} · receipt v${published.revision}` })).toHaveCount(1)

  const serverA2 = await api.receipt(idA, attemptA2)
  const previewA2 = await previewReceipt(page, attemptA2, serverA2.body)
  const downloadedA2 = await downloadReceipt(page, attemptA2)
  expect(downloadedA2.download.suggestedFilename()).toBe('receipt.md')
  expect(downloadedA2.text).toBe(previewA2)
  expect(receiptTitle(previewA2)).toBe(publishedTitle)
  expect(previewA2).toContain(`receipt@${published.revision}`)
  expect(previewA2).toContain(requirementA2)
  const previewA1Again = await previewReceipt(page, attemptA1, previewA1)
  expect(previewA1Again).toBe(previewA1)
  expect(receiptTitle(previewA1Again)).toBe(DEFAULT_SOP.config.title)
  const afterRunA1 = await api.receipt(idA, attemptA1)
  expect(afterRunA1.body).toBe(beforePublishReceipt.body)
  expect(materialRow(previewA2, 'finding').hash).toBe(materialRow(previewA1, 'finding').hash)
  expect(materialRow(previewA2, 'source').hash).toBe(materialRow(previewA1, 'source').hash)

  // 乙单使用同名不同内容的材料，回执与摘要不串单。
  await openWorkspaces(page)
  await openNewWorkspace(page)
  const idB = await createWorkspace(page, requirementB)
  await expectNoOverflow(page)
  await uploadMaterial(page, 'Finding', MATERIAL_NAME, findingB)
  await uploadMaterial(page, '源码包', MATERIAL_NAME, sourceB)
  await executeOnce(page, 'receipt@1')
  await expectNoOverflow(page)
  const detailB = await api.get(idB)
  expect(detailB.frozen).toBe(true)
  expect(detailB.attempts).toHaveLength(1)
  expect(detailB.attempts[0]!.sop).toEqual(DEFAULT_SOP)
  const attemptB1 = detailB.attempts[0]!.id
  const serverB1 = await api.receipt(idB, attemptB1)
  const previewB1 = await previewReceipt(page, attemptB1, serverB1.body)
  const downloadedB1 = await downloadReceipt(page, attemptB1)
  expect(downloadedB1.text).toBe(previewB1)
  expect(receiptTitle(previewB1)).toBe(DEFAULT_SOP.config.title)
  expect(previewB1).toContain(requirementB)
  expect(previewB1).not.toContain(requirementA2)
  expect(previewA1).not.toContain(requirementB)
  expect(previewA2).not.toContain(requirementB)

  const rowA1 = materialRow(previewA1, 'finding')
  const rowB1 = materialRow(previewB1, 'finding')
  expect(rowA1.size).toBe(utf8Size(findingA))
  expect(rowB1.size).toBe(utf8Size(findingB))
  expect(rowA1.hash).not.toBe(rowB1.hash)
  expect(materialRow(previewA1, 'source').hash).not.toBe(materialRow(previewB1, 'source').hash)

  // 同目录重启真实 Server 后，包、两次尝试的 SOP 绑定、独立发布的 SOP 与旧回执都还在。
  const beforeRestartA2 = await api.receipt(idA, attemptA2)
  const beforeRestartB1 = await api.receipt(idB, attemptB1)
  await restartServer()

  await openWorkspaces(page)
  await expectNoOverflow(page)
  await openWorkspaceRow(page, requirementA2)
  await page.getByRole('link', { name: '查看结果与回执' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptA1}` })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptA2}` })).toBeVisible()
  await expectNoOverflow(page)

  const detailAAfterRestart = await api.get(idA)
  expect(detailAAfterRestart).not.toHaveProperty('sop')
  expect(detailAAfterRestart.attempts).toEqual(detailA.attempts)
  expect(detailAAfterRestart.materials).toEqual(detailA.materials)
  expect(detailAAfterRestart.attempts.map(attempt => attempt.sop)).toEqual([DEFAULT_SOP, publishedSop])
  const previewA1AfterRestart = await previewReceipt(page, attemptA1, previewA1)
  expect(previewA1AfterRestart).toBe(previewA1)
  expect(receiptTitle(previewA1AfterRestart)).toBe(DEFAULT_SOP.config.title)
  const previewA2AfterRestart = await previewReceipt(page, attemptA2, previewA2)
  expect(previewA2AfterRestart).toBe(previewA2)
  expect(receiptTitle(previewA2AfterRestart)).toBe(publishedTitle)
  expect((await api.receipt(idA, attemptA2)).body).toBe(beforeRestartA2.body)
  expect((await api.receipt(idA, attemptA1)).body).toBe(beforePublishReceipt.body)

  await page.goto('/sops')
  await expect(page.getByRole('heading', { level: 1, name: 'SOP 管理' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: publishedTitle })).toBeVisible()
  await expectNoOverflow(page)
  expect(await api.sop('receipt', published.revision)).toEqual(publishedSop)

  await openWorkspaces(page)
  await openWorkspaceRow(page, requirementB)
  await page.getByRole('link', { name: '查看结果与回执' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptB1}` })).toBeVisible()
  const previewB1AfterRestart = await previewReceipt(page, attemptB1, previewB1)
  expect(previewB1AfterRestart).toBe(previewB1)
  expect((await api.receipt(idB, attemptB1)).body).toBe(beforeRestartB1.body)
  expect(await api.get(idB)).toEqual(detailB)

  writeEvidence(`workspace-${testInfo.project.name}`, {
    requirements: { a: requirementA2, b: requirementB },
    workspaces: [
      {
        id: idA,
        attempts: detailA.attempts,
        materials: detailA.materials,
        topLevelSop: 'sop' in detailA,
      },
      { id: idB, attempts: detailB.attempts, materials: detailB.materials, topLevelSop: 'sop' in detailB },
    ],
    sop: {
      default: DEFAULT_SOP,
      published: publishedSop,
      rejectedCreateWithSopStatus: rejectedSopCreate.status,
      publishDidNotTouchWorkspace: JSON.stringify(afterPublishDetail) === JSON.stringify(beforePublishDetail),
    },
    receipt: {
      a1: digest(previewA1),
      a2: digest(previewA2),
      b1: digest(previewB1),
      titles: [receiptTitle(previewA1), receiptTitle(previewA2), receiptTitle(previewB1)],
      sopVersions: detailA.attempts.map(attempt => `${attempt.sop.id}@${attempt.sop.revision}`),
      downloadedEqualsPreview: [
        downloadedA1.text === previewA1,
        downloadedA2.text === previewA2,
        downloadedB1.text === previewB1,
      ],
      oldReceiptUnchanged: afterRunA1.body === beforePublishReceipt.body
        && previewA1Again === previewA1
        && previewA1AfterRestart === previewA1,
      survivesRestart: previewA2AfterRestart === previewA2 && previewB1AfterRestart === previewB1,
      sameNameDigestsDiffer: rowA1.hash !== rowB1.hash,
    },
    browserDownloads: [
      downloadedA1.download.suggestedFilename(),
      downloadedA2.download.suggestedFilename(),
      downloadedB1.download.suggestedFilename(),
    ],
    pageErrors,
  })

  expect(pageErrors, '页面不应产生未处理的 JavaScript 错误').toEqual([])
  expect(detailA.id).toBe(idA)
  expect(detailA.typeId).toBe('finding-report')
  expect(detailB.id).toBe(idB)
  expect(detailB.typeId).toBe('finding-report')
})
