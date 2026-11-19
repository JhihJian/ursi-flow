import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { WorkApi } from '../fixtures/api'
import { digest, writeEvidence } from '../fixtures/evidence'
import { restartServer } from '../fixtures/process'
import { readRuntime } from '../fixtures/runtime'
import {
  createWorkspace, downloadReceipt, executeAgain, executeOnce, expectNoOverflow, goToWorkList,
  login, openWorkspace, openWorkspaceRow, openWorkspaces, previewReceipt, saveRequirement, uploadMaterial,
} from './support'

const MATERIAL_NAME = '材料.md'

function utf8Size(text: string) {
  return Buffer.byteLength(text, 'utf8')
}

/** 从回执的 Markdown 表格里取出某个角色的文件大小与内容摘要。 */
function materialRow(receipt: string, role: string) {
  const pattern = new RegExp(`\\| .+（${role}） \\| ${MATERIAL_NAME} \\| (\\d+) 字节 \\| FNV-1a64 ([0-9a-f]{16}) \\|`)
  const match = pattern.exec(receipt)
  if (!match) throw new Error(`回执里没有角色 ${role} 的材料行：\n${receipt}`)
  return { size: Number(match[1]), hash: match[2] }
}

test('同文件名材料的回执、重跑与重启', async ({ page }, testInfo) => {
  const runtime = readRuntime()
  const api = new WorkApi(runtime)
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const requirementA = `甲单 ${suffix}：核对材料回执`
  const requirementA2 = `甲单 ${suffix}：核对材料回执（修订）`
  const requirementB = `乙单 ${suffix}：核对同文件名材料的回执`
  const findingA = `# 甲单线索\n\n线索编号 A-${suffix}\n内容只属于甲单。\n`
  const sourceA = `# 甲单源码包\n\n打包时间 A-${suffix}\n`
  const findingB = `# 乙单线索\n\n线索编号 B-${suffix}\n内容只属于乙单，与甲单文件名相同。\n`
  const sourceB = `# 乙单源码包\n\n打包时间 B-${suffix}\n`
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  // 工作区类型由真实服务端公布，角色与内置 SOP 是浏览器后续步骤的依据。
  const types = await api.types()
  expect(types).toEqual([{
    id: 'finding-report',
    name: '单条线索报告',
    roles: [{ id: 'finding', label: 'Finding' }, { id: 'source', label: '源码包' }],
    sop: { id: 'receipt', revision: 1 },
  }])

  await login(page, runtime.token)
  await openWorkspaces(page)
  await expectNoOverflow(page)

  // 甲单：创建后先修改需求，再上传两个角色、同名的材料。
  const idA = await createWorkspace(page, requirementA)
  await saveRequirement(page, requirementA2)
  await uploadMaterial(page, 'Finding', MATERIAL_NAME, findingA)
  await uploadMaterial(page, '源码包', MATERIAL_NAME, sourceA)

  let detailA = await api.get(idA)
  expect(detailA.requirement).toBe(requirementA2)
  expect(detailA.frozen).toBe(false)
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

  await executeOnce(page)
  await expect(page.getByText('1 次执行')).toBeVisible()
  detailA = await api.get(idA)
  expect(detailA.frozen).toBe(true)
  expect(detailA.attempts).toHaveLength(1)
  expect(detailA.attempts[0].status).toBe('succeeded')
  const attemptA1 = detailA.attempts[0].id

  // 下载与预览必须同一份正文；服务端下载响应带附件头。
  const previewA1 = await previewReceipt(page, attemptA1)
  const downloadedA1 = await downloadReceipt(page, attemptA1)
  expect(downloadedA1.download.suggestedFilename()).toBe('receipt.md')
  expect(downloadedA1.text).toBe(previewA1)
  expect(previewA1).toContain('材料接收回执')
  expect(previewA1).toContain(requirementA2)
  expect(materialRow(previewA1, 'finding').size).toBe(utf8Size(findingA))
  expect(materialRow(previewA1, 'source').size).toBe(utf8Size(sourceA))
  const apiDownloadA1 = await api.receipt(idA, attemptA1, true)
  expect(apiDownloadA1.contentType).toContain('text/plain')
  expect(apiDownloadA1.disposition).toContain('attachment')
  expect(apiDownloadA1.disposition).toContain('receipt.md')
  expect(apiDownloadA1.body).toBe(previewA1)

  // 冻结后需求不可编辑，服务端也拒绝写入；重跑不受影响。
  await page.getByRole('link', { name: '准备工作区' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '准备工作区' })).toBeVisible()
  await expect(page.getByText('工作区已冻结：需求和材料不可修改，仍可重新执行。')).toBeVisible()
  await expect(page.getByLabel('需求', { exact: true })).toBeDisabled()
  await expect(page.getByText('已冻结', { exact: true })).toBeVisible()
  await expect(page.locator('input[type=file]').first()).toBeDisabled()
  await expect(page.getByRole('button', { name: '上传Finding材料' })).toBeDisabled()
  const rejected = await api.patch(idA, '尝试在冻结后修改')
  expect(rejected.status).toBe(409)
  const rejectedUpload = await api.attemptUpload(idA, 'finding', MATERIAL_NAME, findingB)
  expect(rejectedUpload.status).toBe(409)

  // 乙单：同名材料、不同内容，验证两单回执与材料不串。
  await page.getByRole('link', { name: '返回工作区' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '线索报告工作区' })).toBeVisible()
  const idB = await createWorkspace(page, requirementB)
  await expectNoOverflow(page)
  await uploadMaterial(page, 'Finding', MATERIAL_NAME, findingB)
  await uploadMaterial(page, '源码包', MATERIAL_NAME, sourceB)
  await executeOnce(page)
  const detailB = await api.get(idB)
  expect(detailB.frozen).toBe(true)
  expect(detailB.attempts).toHaveLength(1)
  const attemptB1 = detailB.attempts[0].id
  const previewB1 = await previewReceipt(page, attemptB1)
  const downloadedB1 = await downloadReceipt(page, attemptB1)
  expect(downloadedB1.text).toBe(previewB1)
  expect(previewB1).toContain(requirementB)
  expect(previewB1).not.toContain(requirementA2)

  const rowA1 = materialRow(previewA1, 'finding')
  const rowB1 = materialRow(previewB1, 'finding')
  expect(rowA1.size).toBe(utf8Size(findingA))
  expect(rowB1.size).toBe(utf8Size(findingB))
  expect(rowA1.hash).not.toBe(rowB1.hash)
  expect(materialRow(previewA1, 'source').hash).not.toBe(materialRow(previewB1, 'source').hash)

  // 甲单允许重跑；第二次尝试成功并可读回执。
  await page.goto(`/workspaces/${idA}/result`)
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await executeAgain(page)
  detailA = await api.get(idA)
  expect(detailA.attempts).toHaveLength(2)
  expect(detailA.attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'succeeded'])
  const attemptA2 = detailA.attempts[1].id
  await expectNoOverflow(page)
  const previewA2 = await previewReceipt(page, attemptA2)
  const downloadedA2 = await downloadReceipt(page, attemptA2)
  expect(downloadedA2.text).toBe(previewA2)
  expect(previewA2).toContain(requirementA2)

  // 同目录重启真实 Server 后，工作单、材料、尝试与同一尝试的回执仍可查。
  const beforeRestart = await api.receipt(idA, attemptA2)
  await restartServer()
  await goToWorkList(page)
  await openWorkspaces(page)
  await openWorkspaceRow(page, requirementA2)
  await page.getByRole('link', { name: '查看结果与回执' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptA2}` })).toBeVisible()

  const afterRestart = await api.get(idA)
  expect(afterRestart.requirement).toBe(requirementA2)
  expect(afterRestart.attempts).toHaveLength(2)
  expect(afterRestart.materials).toEqual(detailA.materials)
  const previewAfterRestart = await previewReceipt(page, attemptA2)
  expect(previewAfterRestart).toBe(beforeRestart.body)
  const downloadedAfterRestart = await downloadReceipt(page, attemptA2)
  expect(downloadedAfterRestart.text).toBe(previewAfterRestart)

  await openWorkspace(page, requirementB)
  await page.getByRole('link', { name: '查看结果与回执' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '执行结果' })).toBeVisible()
  await expect(page.getByRole('button', { name: `查看回执 ${attemptB1}` })).toBeVisible()
  const previewBAfterRestart = await previewReceipt(page, attemptB1)
  expect(previewBAfterRestart).toBe(previewB1)
  const detailBAfterRestart = await api.get(idB)
  expect(detailBAfterRestart).toEqual(detailB)

  writeEvidence(`workspace-${testInfo.project.name}`, {
    requirements: { a: requirementA2, b: requirementB },
    workspaces: [
      { id: idA, attempts: detailA.attempts, materials: detailA.materials },
      { id: idB, attempts: detailB.attempts, materials: detailB.materials },
    ],
    receipt: {
      a1: digest(previewA1), a2: digest(previewA2), b1: digest(previewB1),
      downloadedEqualsPreview: [downloadedA1.text === previewA1, downloadedA2.text === previewA2, downloadedB1.text === previewB1],
      survivesRestart: previewAfterRestart === beforeRestart.body,
      frozenEditStatus: rejected.status,
      frozenUploadStatus: rejectedUpload.status,
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
})
