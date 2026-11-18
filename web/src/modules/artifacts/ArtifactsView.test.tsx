// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { api } from '@/shared/api'
import type { Artifact, Run } from '@/shared/api/types'
import { useFeedbackStore } from '@/shared/stores/feedback'
import ArtifactsView from './ArtifactsView'

const markdown = '# 支付重试审查报告\n\n## 审查记录\n\n- 幂等键保持一致\n'
const plain = '回归验证建议\n覆盖超时与重复通知。\n'
const artifacts: Artifact[] = [
  { id: 'artifact-1', name: '需求草案.md', path: '/workspace/output/requirements.md', contentType: 'text/markdown', content: '# 客户反馈看板需求草案\n', runId: 'run-1', nodeId: 'discover', attempt: 1, size: 48, createdAt: '2026-01-01T08:00:00.000Z' },
  { id: 'artifact-2', name: '代码审查报告.md', path: '/workspace/output/review.md', contentType: 'text/markdown', content: markdown, runId: 'run-2', nodeId: 'review', attempt: 1, size: 96, createdAt: '2026-01-01T09:00:00.000Z' },
  { id: 'artifact-3', name: '回归验证建议.txt', path: '/workspace/output/regression.txt', contentType: 'text/plain', content: plain, runId: 'run-2', nodeId: 'report', attempt: 2, size: 72, createdAt: '2026-01-01T10:00:00.000Z' },
]
const runs = [
  { id: 'run-1', name: '客户反馈看板 · 需求确认' },
  { id: 'run-2', name: '支付重试逻辑 · 审查完成' },
] as Run[]

let downloads: { href: string; filename: string }[] = []

/** jsdom 的 Blob 没有 text()，用 FileReader 读回下载内容。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result)) }
    reader.onerror = () => { reject(reader.error ?? new Error('读取下载内容失败')) }
    reader.readAsText(blob)
  })
}

function mockApi(resolve: () => Promise<unknown> = async () => undefined) {
  vi.spyOn(api, 'get').mockImplementation(((path: string) => {
    return resolve().then(() => (path === '/runs' ? runs : artifacts))
  }) as typeof api.get)
}

function renderView(entry = '/artifacts') {  const router = createMemoryRouter([{ path: '/artifacts', element: <ArtifactsView /> }], { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  downloads = []
  mockApi()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-artifact')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.getAttribute('href') ?? '', filename: this.download })
  })
})

afterEach(() => {
  cleanup()
  useFeedbackStore.setState({ toasts: [], confirmation: null })
})

describe('产物筛选与归属', () => {
  it('按运行筛选只展示匹配条目，并把运行写入地址栏', async () => {
    const user = userEvent.setup()
    const router = renderView('/artifacts?runId=run-2')

    expect(await screen.findByText('2 个文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /代码审查报告\.md/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /需求草案\.md/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('按运行筛选')).toHaveValue('run-2')

    await user.selectOptions(screen.getByLabelText('按运行筛选'), 'run-1')

    await waitFor(() => { expect(router.state.location.search).toBe('?runId=run-1') })
    expect(await screen.findByText('1 个文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /需求草案\.md/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /代码审查报告\.md/ })).not.toBeInTheDocument()
  })

  it('轮次筛选按执行轮次收敛，切换运行后清除轮次', async () => {
    const user = userEvent.setup()
    renderView('/artifacts?runId=run-2')
    await screen.findByText('2 个文件')

    await user.selectOptions(screen.getByLabelText('执行轮次'), '2')

    expect(await screen.findByText('1 个文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回归验证建议\.txt/ })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('按运行筛选'), 'run-1')

    expect(await screen.findByText('1 个文件')).toBeInTheDocument()
    expect(screen.getByLabelText('执行轮次')).toHaveValue('')
    expect(screen.getByRole('button', { name: /需求草案\.md/ })).toBeInTheDocument()
  })

  it('搜索按文件名与路径过滤，无匹配时展示空态', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('3 个文件')

    await user.type(screen.getByLabelText('搜索产物'), 'regression')

    expect(await screen.findByText('1 个文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /回归验证建议\.txt/ })).toBeInTheDocument()

    await user.clear(screen.getByLabelText('搜索产物'))
    await user.type(screen.getByLabelText('搜索产物'), '不存在的产物')

    expect(await screen.findByText('没有找到产物')).toBeInTheDocument()
  })

  it('请求失败展示可重试错误态并隐藏内容面板', async () => {
    vi.restoreAllMocks()
    mockApi(async () => { throw new Error('产物服务不可用') })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-artifact')
    const user = userEvent.setup()
    renderView()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('暂时无法加载')
    expect(alert).toHaveTextContent('产物服务不可用')
    expect(screen.queryByRole('button', { name: '下载文件' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('预览、源文件与下载', () => {
  it('Markdown 产物渲染标题，源文件展示原始文本', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /代码审查报告\.md/ }))

    expect(screen.getByRole('heading', { name: '支付重试审查报告' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '源文件' }))

    expect(document.querySelector('pre')?.textContent).toBe(markdown)
    expect(screen.queryByRole('heading', { name: '支付重试审查报告' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '内容预览' }))

    expect(screen.getByRole('heading', { name: '支付重试审查报告' })).toBeInTheDocument()
  })

  it('下载使用所选产物文件名与文本内容', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(await screen.findByRole('button', { name: /代码审查报告\.md/ }))
    await user.click(screen.getByRole('button', { name: '下载文件' }))

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
    expect(blob.type).toBe('text/markdown')
    expect(await readBlob(blob)).toBe(markdown)
    expect(downloads).toEqual([{ href: 'blob:mock-artifact', filename: '代码审查报告.md' }])
    expect(useFeedbackStore.getState().toasts.at(-1)?.message).toBe('产物已开始下载')
  })

  it('关联运行链接指向运行详情，运行名称缺失时回退到运行标识', async () => {
    const user = userEvent.setup()
    renderView('/artifacts?runId=run-2')
    await screen.findByText('2 个文件')

    const link = screen.getByRole('link', { name: '支付重试逻辑 · 审查完成' })
    expect(link).toHaveAttribute('href', '/runs/run-2')

    vi.restoreAllMocks()
    mockApi()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-artifact')
    cleanup()
    const router = createMemoryRouter([{ path: '/artifacts', element: <ArtifactsView /> }], { initialEntries: ['/artifacts'] })
    vi.spyOn(api, 'get').mockImplementation(((path: string) => Promise.resolve(path === '/runs' ? [{ id: 'run-9', name: '未命名运行' }] : [{ ...artifacts[1]!, runId: 'run-9' }])) as typeof api.get)
    render(<RouterProvider router={router} />)

    await user.click(await screen.findByRole('button', { name: /代码审查报告\.md/ }))
    expect(screen.getByRole('link', { name: '未命名运行' })).toBeInTheDocument()
  })
})
