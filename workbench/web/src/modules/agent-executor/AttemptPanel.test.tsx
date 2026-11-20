import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setToken } from '@/shared/http/session'
import type { AttemptTarget } from '@/shared/api/agent-executor'
import { AttemptPanel } from './AttemptPanel'

const ref = { executorRef: { id: '核查', revision: 3 } }
const draft = { id: '核查', agent: { systemPrompt: '核对资料', modelProfile: 'small', tools: [] }, resources: [{ id: 'guide', revision: 2 }] }
const preview = { previewDefinition: draft }
const uuid = '9a0fc193-3747-4957-a81f-da4e32f755bf'
const endpoint = `/api/v2/executor-attempts/${uuid}`
const response = (status: string, extra = {}) => Response.json({ attemptId: uuid, status, ...extra })
function network() {
  const mock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
  vi.stubGlobal('fetch', mock)
  return mock
}
function enter(text = ' 请核查\n资料 ') {
  fireEvent.change(screen.getByRole('textbox', { name: '本次指令' }), { target: { value: text } })
}
const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => { setToken('test-token'); vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid) })
afterEach(() => { cleanup(); localStorage.clear(); setToken(''); vi.useRealTimers() })

it('嵌入表单试跑，草稿按内容比较，目标为空仍保留结果', async () => {
  const http = network().mockResolvedValueOnce(response('succeeded'))
  const submit = vi.fn()
  const panel = (target: AttemptTarget | null) => <form onSubmit={submit}><AttemptPanel target={target} /></form>
  const view = render(panel(preview))
  expect(view.container.querySelectorAll('form')).toHaveLength(1)
  enter('   ')
  expect(button('试跑')).toBeDisabled()
  enter()
  await userEvent.click(button('试跑'))
  expect(await screen.findByText('已完成')).toBeVisible()
  expect(submit).not.toHaveBeenCalled()
  expect(http.mock.calls[0][0]).toBe(endpoint)
  expect(JSON.parse(String(http.mock.calls[0][1].body))).toEqual({ ...preview, workInstruction: { encoding: 'utf-8', text: ' 请核查\n资料 ' } })
  view.rerender(panel({ previewDefinition: { ...draft, resources: [{ id: 'guide', revision: 3 }] } }))
  expect(screen.getByText('旧配置的试跑结果')).toBeVisible()
  view.rerender(panel(structuredClone(preview)))
  expect(screen.queryByText('旧配置的试跑结果')).toBeNull()
  view.rerender(panel(null))
  expect(button('启动')).toBeDisabled()
  expect(screen.getByText('已完成')).toBeVisible()
  expect(http).toHaveBeenCalledTimes(1)
})

it('工作包先保存 UUID，丢失回执后原 ID GET，重试与重挂载均不重发 PUT', async () => {
  let storedAtStart: string | null = null
  const http = network().mockImplementationOnce(async () => {
    storedAtStart = localStorage.getItem('patch:A')
    throw new TypeError('断线')
  }).mockRejectedValueOnce(new TypeError('无法查询'))
    .mockResolvedValueOnce(response('unverified')).mockResolvedValueOnce(response('succeeded'))
  const props = { target: ref, workPatchId: 'A', storageKey: 'patch:A' }
  const view = render(<AttemptPanel {...props} />)
  enter()
  await userEvent.click(button('启动'))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法查询')
  expect(screen.getByText(uuid)).toBeVisible()
  expect(button('启动')).toBeDisabled()
  await userEvent.click(button('重新查询'))
  expect(await screen.findByText('待核实')).toBeVisible()
  view.unmount()
  render(<AttemptPanel {...props} target={null} />)
  expect(await screen.findByText('已完成')).toBeVisible()
  expect(http.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual(['PUT', 'GET', 'GET', 'GET'].map(method => [endpoint, method]))
  expect(JSON.parse(String(http.mock.calls[0][1].body))).toEqual({ ...ref, workPatchId: 'A', workInstruction: { encoding: 'utf-8', text: ' 请核查\n资料 ' } })
  expect(storedAtStart).toBe(uuid)
  expect(localStorage.length).toBe(1)
})

it('回执属于另一尝试或状态未知时只核对原 UUID，不读取该回执的制品', async () => {
  const http = network().mockResolvedValueOnce(response('succeeded', { attemptId: 'other', artifactDirectoryId: 'foreign' }))
    .mockResolvedValueOnce(response('unknown', { artifactDirectoryId: 'foreign' })).mockResolvedValueOnce(response('succeeded'))
  render(<AttemptPanel target={ref} />)
  enter()
  await userEvent.click(button('启动'))
  expect(await screen.findByRole('alert')).toHaveTextContent('查询失败')
  await userEvent.click(button('重新查询'))
  expect(await screen.findByText('已完成')).toBeVisible()
  expect(http.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual(['PUT', 'GET', 'GET'].map(method => [endpoint, method]))
})

it('轮询启动中与运行中，目标清空后仍可取消，忽略取消前迟到的响应', async () => {
  vi.useFakeTimers()
  let finishPoll!: (result: Response) => void
  const pending = new Promise<Response>(resolve => { finishPoll = resolve })
  const http = network().mockResolvedValueOnce(response('starting')).mockResolvedValueOnce(response('running'))
    .mockReturnValueOnce(pending).mockResolvedValueOnce(response('cancelled'))
  const view = render(<AttemptPanel target={ref} />)
  enter()
  await act(async () => { fireEvent.click(button('启动')) })
  expect(screen.getByText('启动中')).toBeVisible()
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(screen.getByText('运行中')).toBeVisible()
  await act(() => vi.advanceTimersByTimeAsync(1000))
  view.rerender(<AttemptPanel target={null} />)
  await act(async () => { fireEvent.click(button('取消')) })
  expect(screen.getByText('已取消')).toBeVisible()
  expect(http.mock.calls[3][0]).toBe(`${endpoint}/cancel`)
  expect(http.mock.calls[3][1].method).toBe('POST')
  await act(async () => { finishPoll(response('running')); await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
  expect(screen.getByText('已取消')).toBeVisible()
  expect(http).toHaveBeenCalledTimes(4)
})

it('按目录 ID 只读文件：显示文本，二进制下载保留原字节与文件名', async () => {
  const file = (body: BodyInit) => new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } })
  const paths = ['报告/核查.txt', '报告/附件.bin']
  const bytes = Uint8Array.of(255, 0, 17)
  const http = network().mockResolvedValueOnce(response('succeeded', { artifactDirectoryId: 'outputs' }))
    .mockResolvedValueOnce(Response.json(paths.map(path => ({ path, kind: 'file' }))))
    .mockResolvedValueOnce(file('<b>通过</b>')).mockResolvedValueOnce(file(bytes))
  localStorage.setItem('A', uuid)
  render(<AttemptPanel target={null} storageKey="A" />)
  await userEvent.click(await screen.findByRole('button', { name: paths[0] }))
  expect(await screen.findByText('<b>通过</b>')).toBeVisible()
  await userEvent.click(button(paths[1]))
  expect(await screen.findByText('二进制文件，请下载查看。')).toBeVisible()
  expect(screen.queryByText('<b>通过</b>')).toBeNull()
  const create = vi.fn((_blob: Blob) => 'blob:test')
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('附件.bin'); expect(this.href).toBe('blob:test')
  })
  await userEvent.click(button('下载文件'))
  expect(click).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:test'))
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(create.mock.calls[0][0])
  })
  expect(Array.from(new Uint8Array(buffer))).toEqual([...bytes])
  expect(http.mock.calls[1][0]).toBe('/api/v2/directories/outputs/tree')
  expect(http.mock.calls.slice(2).map(([url]) => new URL(url, 'http://local').searchParams.get('path'))).toEqual(paths)
  expect(http.mock.calls.every(([, init]) => (init.method ?? 'GET') === 'GET')).toBe(true)
})
