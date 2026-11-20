import { expect, test } from '@playwright/test'
import { readRuntime } from '../../patches-acceptance/fixtures/runtime'
import { login } from '../../patches-acceptance/tests/support'
import { navigate } from '../../e2e/fixtures'

test('资源与执行器独立发布新版，旧执行器保留固定的资源版本', async ({ page }, info) => {
  const resource = `guide-${info.project.name}`
  const executor = `assistant-${info.project.name}`
  await login(page, readRuntime().token)
  await navigate(page, '资源库')
  await page.getByRole('link', { name: '新建资源' }).click()
  await page.getByLabel('资源 ID', { exact: true }).fill(resource)
  await page.getByLabel('资源类型').selectOption('prompt')
  await page.getByLabel('资源内容').fill('核对材料编号')
  await page.getByRole('button', { name: '发布资源' }).click()
  await expect(page.getByRole('heading', { name: `${resource} v1` })).toBeVisible()

  await navigate(page, '执行器')
  await page.getByRole('link', { name: '新建执行器' }).click()
  await page.getByLabel('执行器 ID').fill(executor)
  await page.getByRole('button', { name: '添加执行器资源' }).click()
  await page.getByLabel('资源 ID', { exact: true }).selectOption(resource)
  await page.getByLabel('资源版本').selectOption('1')
  await page.getByRole('button', { name: '发布执行器' }).click()
  await expect(page.getByRole('heading', { name: `${executor} v1` })).toBeVisible()
  const frozen = page.url()

  await page.goto(`/resources/${resource}/revisions/1/edit`)
  await page.getByLabel('资源内容').fill('核对材料编号与结论')
  await page.getByRole('button', { name: '发布新版' }).click()
  await expect(page.getByRole('heading', { name: `${resource} v2` })).toBeVisible()
  await page.goto(`${frozen}/edit`)
  await page.getByLabel('资源版本').selectOption('2')
  await page.getByRole('button', { name: '发布新版' }).click()
  await expect(page.getByRole('heading', { name: `${executor} v2` })).toBeVisible()
  await expect(page.getByRole('link', { name: `${resource} v2` })).toBeVisible()

  await page.goto(frozen)
  await page.getByRole('link', { name: `${resource} v1` }).click()
  await expect(page.getByText('核对材料编号', { exact: true })).toBeVisible()
})
