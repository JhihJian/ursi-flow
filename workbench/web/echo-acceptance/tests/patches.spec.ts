import { expect, test, type Page } from '@playwright/test'

import {
  expectEntry, expectText, PatchApi, patchIdFromUrl, shot,
} from './patches-support'
import { login } from './support'

const WORK_FOLDER = '材料'
const WORK_FILE = `${WORK_FOLDER}/记录.md`
const MCP_SERVERS = '{\n  "mcpServers": {\n    "demo": { "command": "echo" }\n  }\n}'

/** 两类包共用的新建入口：列表页按钮 → 名称对话框 → 落到包编辑台。 */
async function createPatch(page: Page, kind: 'work' | 'config', name: string) {
  const title = kind === 'work' ? '工作包' : '配置包'
  const listPath = kind === 'work' ? '/work-patches' : '/config-patches'
  await page.goto(listPath)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await page.getByRole('button', { name: `新建${title}` }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('名称').fill(name)
  await dialog.getByRole('button', { name: '创建' }).click()
  await page.waitForURL(url => new RegExp(`^${listPath}/[^/]+$`).test(url.pathname))
  await expect(page.getByTestId('patch-studio')).toBeVisible()
  return patchIdFromUrl(page.url(), kind)
}

/** 重新载入后打开目标文件；窄屏先从文件列表逐级进入编辑器。 */
async function reopenFile(page: Page, path: string, textareaLabel: string) {
  const textarea = page.getByLabel(textareaLabel)
  await expect(page.getByTestId('explorer-row').first()).toBeVisible()
  for (const segment of path.split('/').slice(0, -1)) {
    const folder = page.getByRole('button', { name: segment, exact: true })
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click()
  }
  await page.getByRole('button', { name: path.split('/').at(-1)!, exact: true }).click()
  await expect(textarea).toBeVisible()
  return textarea
}

test('工作包：新建空包、建目录与文件、保存后重读', async ({ page }, testInfo) => {
  const api = new PatchApi()
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const name = `结算排查 ${suffix}`
  const content = `# 记录 ${suffix}\n\n浏览器写入，重载后应原样读回。\n`
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await login(page, api.token)
  await page.goto('/work-patches')
  await expect(page.getByRole('heading', { level: 1, name: '工作包' })).toBeVisible()
  await shot(page, testInfo, 'work-list')

  const id = await createPatch(page, 'work', name)
  await expect(page.getByTestId('patch-explorer')).toBeVisible()
  await expect(page.getByText('目录为空，可新建文件或导入目录。')).toBeVisible()
  expect(await api.tree('work', id)).toEqual([])
  await shot(page, testInfo, 'work-empty')

  // 先建目录，再用带 / 的文件名落到该目录内。
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  const folderInput = page.getByLabel('新目录名称')
  await expect(folderInput).toBeVisible()
  await folderInput.fill(WORK_FOLDER)
  await folderInput.press('Enter')
  await expect(page.getByRole('button', { name: WORK_FOLDER, exact: true })).toBeVisible()
  await expectEntry(api, 'work', id, { path: WORK_FOLDER, kind: 'dir' })

  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  const fileInput = page.getByLabel('新文件名称')
  await expect(fileInput).toBeVisible()
  await fileInput.fill(WORK_FILE)
  await fileInput.press('Enter')
  await expectEntry(api, 'work', id, { path: WORK_FILE, kind: 'file' })

  const editor = page.getByLabel(`${WORK_FILE} 内容`)
  await expect(editor).toBeVisible()
  await editor.fill(content)
  const save = page.getByRole('button', { name: '保存', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.locator('.toast-region').getByText('已保存。', { exact: true })).toBeVisible()
  await expectText(api, 'work', id, WORK_FILE, content)
  await shot(page, testInfo, 'work-editor-saved')

  // 重载后从真实服务端重读，桌面自动打开 Markdown，窄屏从列表进入。
  await page.reload()
  await expect(page.getByTestId('patch-studio')).toBeVisible()
  const reopened = await reopenFile(page, WORK_FILE, `${WORK_FILE} 内容`)
  await expect(reopened).toHaveValue(content)
  await shot(page, testInfo, 'work-editor-reloaded')

  expect(pageErrors).toEqual([])
})

test('配置包：默认锚点、编辑提示词、MCP 拒绝坏 JSON、创建 Skill', async ({ page }, testInfo) => {
  const api = new PatchApi()
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const name = `审核配置 ${suffix}`
  const prompt = `# 系统提示词 ${suffix}\n\n只做验收，不接执行。\n`
  const skill = `review-${suffix.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await login(page, api.token)
  await page.goto('/config-patches')
  await expect(page.getByRole('heading', { level: 1, name: '配置包' })).toBeVisible()
  await shot(page, testInfo, 'config-list')

  const id = await createPatch(page, 'config', name)
  await expect(page.getByTestId('patch-studio')).toBeVisible()
  await expect(page.getByRole('tablist', { name: '配置补丁分区' })).toBeVisible()

  // 服务端默认写入三个锚点，界面不提供移动和删除。
  const tree = await api.tree('config', id)
  expect(tree.find(entry => entry.path === 'AGENTS.md' && entry.kind === 'file')).toBeTruthy()
  expect(tree.find(entry => entry.path === 'skills' && entry.kind === 'dir')).toBeTruthy()
  expect(tree.find(entry => entry.path === 'mcp.json' && entry.kind === 'file')).toBeTruthy()
  expect(JSON.parse(await api.text('config', id, 'mcp.json'))).toEqual({ mcpServers: {} })

  // 系统提示词保存在 AGENTS.md，保存后服务端原文与重载后的编辑区一致。
  const promptEditor = page.getByLabel('AGENTS.md 内容')
  await expect(promptEditor).toBeVisible()
  await promptEditor.fill(prompt)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expectText(api, 'config', id, 'AGENTS.md', prompt)
  await expect(page.getByRole('status').filter({ hasText: '已保存' }).first()).toBeVisible()
  await shot(page, testInfo, 'config-prompt')

  await page.reload()
  await expect(page.getByTestId('patch-studio')).toBeVisible()
  await expect(page.getByLabel('AGENTS.md 内容')).toHaveValue(prompt)
  await shot(page, testInfo, 'config-prompt-reloaded')

  // 坏 JSON 只留在草稿里，保存入口不可用，已有 mcp.json 不变。
  await page.getByRole('tab', { name: 'MCP' }).click()
  const mcpEditor = page.getByLabel('mcp.json 内容')
  await expect(mcpEditor).toBeVisible()
  const originalMcp = await api.text('config', id, 'mcp.json')
  expect(JSON.parse(await mcpEditor.inputValue())).toEqual({ mcpServers: {} })
  await mcpEditor.fill('{"mcpServers": ')
  await expect(page.getByRole('alert')).toContainText('JSON 无法解析')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  expect(await api.text('config', id, 'mcp.json')).toBe(originalMcp)
  await shot(page, testInfo, 'config-mcp-invalid')

  await mcpEditor.fill(MCP_SERVERS)
  await expect(page.getByRole('alert')).toHaveCount(0)
  const saveMcp = page.getByRole('button', { name: '保存', exact: true })
  await expect(saveMcp).toBeEnabled()
  await saveMcp.click()
  await expectText(api, 'config', id, 'mcp.json', MCP_SERVERS)
  expect(JSON.parse(await api.text('config', id, 'mcp.json'))).toEqual(JSON.parse(MCP_SERVERS))

  await page.reload()
  await expect(page.getByTestId('patch-studio')).toBeVisible()
  await page.getByRole('tab', { name: 'MCP' }).click()
  await expect(page.getByLabel('mcp.json 内容')).toHaveValue(MCP_SERVERS)

  // 新建 Skill 会在 skills/ 下建目录与 SKILL.md，并在共享编辑器里打开入口文件。
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByLabel('新建 Skill 名称').fill(skill)
  await page.getByTestId('skill-create').click()
  await expect(page.getByTestId(`skill-item-${skill}`)).toBeVisible()
  await expectEntry(api, 'config', id, { path: `skills/${skill}`, kind: 'dir' })
  await expectEntry(api, 'config', id, { path: `skills/${skill}/SKILL.md`, kind: 'file' })
  const skillText = await api.text('config', id, `skills/${skill}/SKILL.md`)
  expect(skillText).toContain(`name: ${skill}`)
  const skillEditor = page.getByLabel(`skills/${skill}/SKILL.md 内容`)
  await expect(skillEditor).toBeVisible()
  await expect(skillEditor).toHaveValue(skillText)
  await shot(page, testInfo, 'config-skill')

  expect(pageErrors).toEqual([])
})
