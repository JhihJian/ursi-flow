import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Connection, Role, Run, Sandbox, Workflow } from '@/shared/api/types'
import { createMockBackend, STORAGE_KEY, type MockStorage } from './backend'

const start = new Date('2026-06-10T08:00:00Z').getTime()
function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
}
function harness(storage?: MockStorage, delay = 0) {
  const backend = createMockBackend(storage, { delay })
  async function call<T>(path: string, method = 'GET', body?: unknown) {
    const pending = backend.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    await vi.runOnlyPendingTimersAsync()
    const response = await pending
    return { status: response.status, data: response.status === 204 ? undefined as T : await response.json() as T, response }
  }
  return { ...backend, call }
}
type ApiFailure = { error: { code: string; message: string } }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start) })
afterEach(() => vi.useRealTimers())

describe('本地演示 API', () => {
  it('提供完整中文示例，列表与详情直接返回 DTO', async () => {
    const api = harness()
    expect((await api.call<Role[]>('/roles')).data).toHaveLength(4)
    expect((await api.call<Connection[]>('/connections')).data).toHaveLength(2)
    expect((await api.call<Workflow[]>('/workflows')).data.map(item => item.name)).toEqual(['产品需求交付', '代码审查', '文档整理'])
    expect((await api.call<Run[]>('/runs')).data.map(item => item.status)).toEqual(['waiting', 'succeeded', 'running'])
    expect((await api.call<Artifact[]>('/artifacts')).data).toHaveLength(3)
    expect((await api.call<Sandbox[]>('/sandboxes')).data).toHaveLength(3)
    expect((await api.call<Artifact>('/artifacts/artifact-1')).data.content).toContain('客户反馈看板')
    expect((await api.call('/roles/role-product')).response.headers.get('content-type')).toContain('application/json')
  })

  it('角色和连接删除拒绝现存引用，删除流程不影响运行快照', async () => {
    const api = harness()
    for (const path of ['/roles/role-product', '/connections/conn-openai']) {
      const result = await api.call<ApiFailure>(path, 'DELETE')
      expect(result.status).toBe(409)
      expect(result.data.error.code).toBe('REFERENCE_CONFLICT')
    }
    expect((await api.call('/workflows/wf-product', 'DELETE')).status).toBe(204)
    expect((await api.call('/roles/role-product', 'DELETE')).status).toBe(204)
    const run = (await api.call<Run>('/runs/run-1')).data
    expect(run.snapshot.roles.some(role => role.id === 'role-product')).toBe(true)
    expect(run.snapshot.workflow.name).toBe('产品需求交付')
    expect((await api.call('/roles/role-product')).status).toBe(404)
  })

  it('支持配置创建、修改、复制与删除，复制对象独立', async () => {
    const api = harness()
    const original = (await api.call<Role>('/roles/role-product')).data
    const copy = await api.call<Role>('/roles/role-product/copy', 'POST')
    expect(copy.status).toBe(201)
    expect(copy.data.name).toContain('副本')
    await api.call(`/roles/${copy.data.id}`, 'PUT', { skills: [{ name: '新技能', content: '新内容' }] })
    expect((await api.call<Role>('/roles/role-product')).data).toEqual(original)
    expect((await api.call(`/roles/${copy.data.id}`, 'DELETE')).status).toBe(204)
    const workflow = (await api.call<Workflow>('/workflows/wf-review/copy', 'POST')).data
    await api.call(`/workflows/${workflow.id}`, 'PUT', { name: '独立审查流程' })
    expect((await api.call<Workflow>('/workflows/wf-review')).data.name).toBe('代码审查')
    const connection = (await api.call<Connection>('/connections', 'POST', { name: '本地模型', provider: 'Ollama', baseUrl: 'http://localhost:11434', model: 'qwen3', credentialRef: '' })).data
    expect((await api.call(`/connections/${connection.id}`, 'PUT', { name: '团队本地模型' })).status).toBe(200)
    expect((await api.call(`/connections/${connection.id}`, 'DELETE')).status).toBe(204)
  })

  it('运行使用创建时的深拷贝，修改三类配置不影响旧运行', async () => {
    const api = harness()
    const run = (await api.call<Run>('/runs', 'POST', { workflowId: 'wf-product', input: '建设客户中心', name: '客户中心一期' })).data
    await api.call('/roles/role-product', 'PUT', { systemPrompt: '新的提示词', skills: [{ name: '新版', content: '新版技能' }] })
    await api.call('/connections/conn-openai', 'PUT', { baseUrl: 'https://example.com/v1' })
    await api.call('/workflows/wf-product', 'PUT', { name: '新版产品交付' })
    expect((await api.call<Run>(`/runs/${run.id}`)).data.snapshot).toEqual(run.snapshot)
    const newer = (await api.call<Run>('/runs', 'POST', { workflowId: 'wf-product', input: '新任务' })).data
    expect(newer.snapshot.roles.find(role => role.id === 'role-product')?.systemPrompt).toBe('新的提示词')
    expect(newer.snapshot.connections[0]?.baseUrl).toBe('https://example.com/v1')
    expect(newer.workflowName).toBe('新版产品交付')
  })

  it('每步推进两秒，等待审批，审批后完成并自动释放沙箱', async () => {
    const api = harness()
    const run = (await api.call<Run>('/runs', 'POST', { workflowId: 'wf-product', input: '新增反馈看板' })).data
    expect(run.nodes[0]?.status).toBe('running')
    vi.setSystemTime(start + 1999)
    expect((await api.call<Run>(`/runs/${run.id}`)).data.nodes[0]?.status).toBe('running')
    vi.setSystemTime(start + 2000)
    expect((await api.call<Run>(`/runs/${run.id}`)).data.status).toBe('waiting')
    vi.setSystemTime(start + 200_000)
    expect((await api.call<Run>(`/runs/${run.id}`)).data.status).toBe('waiting')
    const approved = (await api.call<Run>(`/runs/${run.id}/approve`, 'POST')).data
    expect(approved.status).toBe('running')
    expect(approved.nodes[2]?.status).toBe('running')
    vi.setSystemTime(start + 204_000)
    const finished = (await api.call<Run>(`/runs/${run.id}`)).data
    expect(finished.status).toBe('succeeded')
    expect(finished.nodes.every(node => node.status === 'succeeded')).toBe(true)
    const artifacts = (await api.call<Artifact[]>(`/artifacts?runId=${run.id}&attempt=1`)).data
    expect(artifacts).toHaveLength(3)
    expect(artifacts.every(item => item.size === new TextEncoder().encode(item.content).length)).toBe(true)
    expect((await api.call<Sandbox>(`/sandboxes/${run.sandboxId}`)).data.status).toBe('released')
    expect(finished.events.map(item => item.id)).toEqual([...finished.events.map(item => item.id)].sort())
    expect(new Set(finished.events.map(item => item.id)).size).toBe(finished.events.length)
    expect((await api.call<Run>(`/runs/${run.id}`)).data).toEqual(finished)
  })

  it('返工只接受祖先，重置下游并增加轮次，保留上一轮产物', async () => {
    const api = harness()
    for (const targetNodeId of ['confirm', 'handoff', 'missing']) {
      const rejected = await api.call<ApiFailure>('/runs/run-1/reject', 'POST', { targetNodeId })
      expect(rejected.status).toBe(400)
      expect(rejected.data.error.code).toBe('VALIDATION')
    }
    const run = (await api.call<Run>('/runs/run-1/reject', 'POST', { targetNodeId: 'discover' })).data
    expect(run.attempt).toBe(2)
    expect(run.nodes.map(node => node.status)).toEqual(['running', 'pending', 'pending', 'pending'])
    expect(run.nodes[0]?.output).toBeUndefined()
    vi.setSystemTime(start + 2000)
    expect((await api.call<Run>('/runs/run-1')).data.status).toBe('waiting')
    expect((await api.call<Artifact[]>('/artifacts?runId=run-1&attempt=1')).data).toHaveLength(1)
    expect((await api.call<Artifact[]>('/artifacts?runId=run-1&attempt=2')).data).toHaveLength(1)
    await api.call('/runs/run-1/approve', 'POST')
    vi.setSystemTime(start + 6000)
    expect((await api.call<Run>('/runs/run-1')).data.status).toBe('succeeded')
    expect((await api.call<Artifact[]>('/artifacts?runId=run-1&attempt=2')).data).toHaveLength(3)
  })

  it('活动运行拒绝手动释放，取消后冻结节点并释放沙箱', async () => {
    const api = harness()
    expect((await api.call('/sandboxes/sandbox-3/release', 'POST')).status).toBe(409)
    const cancelled = (await api.call<Run>('/runs/run-3/cancel', 'POST')).data
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nodes.every(node => node.status === 'cancelled')).toBe(true)
    vi.setSystemTime(start + 100_000)
    expect((await api.call<Run>('/runs/run-3')).data).toEqual(cancelled)
    expect((await api.call<Sandbox>('/sandboxes/sandbox-3/release', 'POST')).data.status).toBe('released')
    for (const action of ['approve', 'reject', 'cancel']) expect((await api.call(`/runs/run-3/${action}`, 'POST', { targetNodeId: 'collect' })).status).toBe(409)
    expect((await api.call<Artifact[]>('/artifacts?runId=run-3')).data).toHaveLength(0)
  })

  it('非审批运行不能放行或返工', async () => {
    const api = harness()
    expect((await api.call('/runs/run-3/approve', 'POST')).status).toBe(409)
    expect((await api.call('/runs/run-2/reject', 'POST', { targetNodeId: 'review' })).status).toBe(409)
  })

  it('并行分支完成后才启动汇合节点，数组顺序不决定依赖顺序', async () => {
    const api = harness()
    const workflow = (await api.call<Workflow>('/workflows', 'POST', {
      name: '并行审查', nodes: [
        { id: 'join', name: '汇总', type: 'script', script: 'echo demo' },
        { id: 'left', name: '审查', type: 'agent', roleId: 'role-reviewer' },
        { id: 'right', name: '文档', type: 'agent', roleId: 'role-writer' },
      ], edges: [{ source: 'left', target: 'join' }, { source: 'right', target: 'join' }],
    })).data
    const run = (await api.call<Run>('/runs', 'POST', { workflowId: workflow.id, input: '并行检查' })).data
    expect(run.nodes.map(node => node.status)).toEqual(['pending', 'running', 'running'])
    vi.setSystemTime(start + 2000)
    expect((await api.call<Run>(`/runs/${run.id}`)).data.nodes.map(node => node.status)).toEqual(['running', 'succeeded', 'succeeded'])
    vi.setSystemTime(start + 4000)
    expect((await api.call<Run>(`/runs/${run.id}`)).data.status).toBe('succeeded')
  })

  it('状态持久化到指定键，重新实例化恢复快照和进度', async () => {
    const storage = memoryStorage()
    const api = harness(storage)
    await api.call('/roles/role-product', 'PUT', { name: '产品负责人' })
    expect(storage.setItem).toHaveBeenLastCalledWith(STORAGE_KEY, expect.any(String))
    const saved = storage.getItem(STORAGE_KEY)
    const reopened = harness(storage)
    expect((await reopened.call<Role>('/roles/role-product')).data.name).toBe('产品负责人')
    expect((await reopened.call<Run>('/runs/run-1')).data.snapshot.roles[0]?.name).toBe('产品分析师')
    expect(storage.getItem(STORAGE_KEY)).toBe(saved)
    vi.setSystemTime(start + 4000)
    expect((await reopened.call<Run>('/runs/run-3')).data.status).toBe('succeeded')
  })

  it('成功编辑一次持久化，校验失败不修改状态或消耗编号', async () => {
    const storage = memoryStorage()
    const api = harness(storage)
    storage.setItem.mockClear()
    await api.call('/roles/role-product', 'PUT', { name: '新名称' })
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    const before = storage.getItem(STORAGE_KEY)
    await api.call('/roles', 'POST', { name: '' })
    expect(storage.getItem(STORAGE_KEY)).toBe(before)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect((await api.call<Role>('/roles/role-product/copy', 'POST')).data.id).toBe('role-101')
  })

  it('保存失败返回 503 并回滚整个编辑', async () => {
    const storage = memoryStorage()
    const api = harness(storage)
    storage.setItem.mockImplementationOnce(() => { throw new Error('quota exceeded') })
    expect((await api.call('/roles/role-product', 'PUT', { name: '不能保存' })).status).toBe(503)
    expect((await api.call<Role>('/roles/role-product')).data.name).toBe('产品分析师')
  })

  it('错误注入只影响下一次普通请求，设置读取与重置不被拦截', async () => {
    const api = harness()
    expect((await api.call('/demo/settings', 'PUT', { delay: 0, failNext: true })).status).toBe(200)
    expect((await api.call<{ failNext: boolean }>('/demo/settings')).data.failNext).toBe(true)
    const failed = await api.call<ApiFailure>('/roles')
    expect(failed.status).toBe(503)
    expect(failed.data.error.code).toBe('SERVICE_UNAVAILABLE')
    expect((await api.call('/roles')).status).toBe(200)
    await api.call('/demo/settings', 'PUT', { delay: 0, failNext: true })
    expect((await api.call('/demo/reset', 'POST')).status).toBe(200)
    expect((await api.call('/roles')).status).toBe(200)
    expect((await api.call('/demo/settings', 'PUT', { delay: -1, failNext: false })).status).toBe(400)
  })

  it('重置恢复新鲜种子，修改过的快照和产物不会污染种子', async () => {
    const api = harness()
    await api.call('/roles/role-product', 'PUT', { skills: [] })
    await api.call('/runs/run-1/reject', 'POST', { targetNodeId: 'discover' })
    await api.call('/workflows/wf-review', 'DELETE')
    await api.call('/demo/reset', 'POST')
    expect((await api.call<Role>('/roles/role-product')).data.skills).toHaveLength(1)
    expect((await api.call<Run>('/runs/run-1')).data.attempt).toBe(1)
    expect((await api.call<Workflow[]>('/workflows')).data).toHaveLength(3)
    expect((await api.call<Artifact[]>('/artifacts')).data).toHaveLength(3)
  })

  it.each([
    { name: '' }, { systemPrompt: '  ' }, { connectionId: 'missing' },
    { token: 'secret' }, { mcpServers: [{ name: '工具', transport: 'http', url: 'https://user:pass@example.com' }] },
    { mcpServers: [{ name: '工具', transport: 'http', url: 'https://example.com', apiKey: 'secret' }] },
  ])('拒绝非法角色与凭据：%j', async body => {
    const api = harness()
    expect((await api.call('/roles/role-product', 'PUT', body)).status).toBe(400)
  })

  it.each(['invalid-url', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com?token=secret'])('拒绝不合法连接地址 %s', async baseUrl => {
    const api = harness()
    expect((await api.call('/connections/conn-openai', 'PUT', { baseUrl })).status).toBe(400)
    expect((await api.call<Connection>('/connections/conn-openai')).data.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('禁止保存连接 token，连接测试明确返回模拟结果', async () => {
    const api = harness()
    expect((await api.call('/connections/conn-openai', 'PUT', { token: 'plaintext' })).status).toBe(400)
    expect((await api.call('/connections/conn-openai/test', 'POST')).data).toEqual({ ok: true, message: '模拟连接验证成功', latency: 0 })
  })

  it.each([
    { nodes: [], edges: [] },
    { nodes: [{ id: 'a', name: 'A', type: 'agent', roleId: 'missing' }], edges: [] },
    { nodes: [{ id: 'a', name: 'A', type: 'approval' }], edges: [{ source: 'a', target: 'missing' }] },
    { nodes: [{ id: 'a', name: 'A', type: 'approval' }, { id: 'a', name: '重复', type: 'approval' }], edges: [] },
    { nodes: [{ id: 'a', name: 'A', type: 'approval' }, { id: 'b', name: 'B', type: 'approval' }], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] },
  ])('拒绝非法 DAG %j', async body => {
    const api = harness()
    const result = await api.call<ApiFailure>('/workflows', 'POST', { name: '非法流程', ...body })
    expect(result.status).toBe(400)
    expect(result.data.error.code).toBe('INVALID_WORKFLOW')
    expect((await api.call<Workflow[]>('/workflows')).data).toHaveLength(3)
  })

  it('未知资源、非法 JSON 和非法筛选返回结构化错误', async () => {
    const api = harness()
    for (const path of ['/unknown', '/runs/missing', '/roles/role-product/unknown', '/artifacts/missing']) {
      const result = await api.call<ApiFailure>(path)
      expect(result.status).toBe(404)
      expect(result.data.error.code).toBe('NOT_FOUND')
    }
    expect((await api.call('/artifacts?attempt=abc')).status).toBe(400)
    const pending = api.fetch('/api/roles', { method: 'POST', body: '{' })
    await vi.runOnlyPendingTimersAsync()
    expect((await pending).status).toBe(400)
  })

  it('默认约 180ms 延迟，AbortSignal 可取消且不写入或消费错误开关', async () => {
    const storage = memoryStorage()
    const api = createMockBackend(storage)
    storage.setItem.mockClear()
    const controller = new AbortController()
    const pending = api.fetch('/api/roles/role-product', { method: 'PUT', body: JSON.stringify({ name: '不应保存' }), signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(179)
    expect(storage.setItem).not.toHaveBeenCalled()
    controller.abort()
    await assertion
    expect(storage.setItem).not.toHaveBeenCalled()
    const beforeAborted = new AbortController()
    beforeAborted.abort()
    await expect(api.fetch('/api/roles', { signal: beforeAborted.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const read = api.fetch('/api/roles/role-product')
    await vi.advanceTimersByTimeAsync(180)
    expect((await (await read).json() as Role).name).toBe('产品分析师')
  })

  it('兼容 Request 对象、URL 输入和 RequestInit 覆盖', async () => {
    const api = harness()
    const request = new Request('http://localhost/api/roles/role-product', { method: 'PUT', body: JSON.stringify({ name: 'Request 请求' }) })
    const pending = api.fetch(request)
    await vi.runOnlyPendingTimersAsync()
    expect((await (await pending).json() as Role).name).toBe('Request 请求')
    const read = api.fetch(new URL('http://localhost/api/roles/role-product'))
    await vi.runOnlyPendingTimersAsync()
    expect((await read).status).toBe(200)
  })

  it('初始种子立即持久化，刷新不会改变标识、时间或重启模拟时钟', async () => {
    const storage = memoryStorage()
    const first = harness(storage)
    const before = (await first.call<Run>('/runs/run-3')).data
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    vi.setSystemTime(start + 1000)
    const reopened = harness(storage)
    expect((await reopened.call<Run>('/runs/run-3')).data).toEqual(before)
    vi.setSystemTime(start + 2000)
    const progressed = (await reopened.call<Run>('/runs/run-3')).data
    expect(progressed.nodes[0]?.status).toBe('succeeded')
    expect(progressed.nodes[1]?.status).toBe('running')
    expect(progressed.createdAt).toBe(before.createdAt)
  })

  it('取消延迟中的请求不消费 failNext，错误开关也会持久化', async () => {
    const storage = memoryStorage()
    const api = harness(storage)
    await api.call('/demo/settings', 'PUT', { delay: 180, failNext: true })
    const reopened = harness(storage)
    const controller = new AbortController()
    const pending = reopened.fetch('/api/roles', { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect((await reopened.call<{ failNext: boolean }>('/demo/settings')).data.failNext).toBe(true)
    expect((await reopened.call('/roles')).status).toBe(503)
    expect((await reopened.call('/roles')).status).toBe(200)
    expect((await harness(storage).call<{ failNext: boolean }>('/demo/settings')).data.failNext).toBe(false)
  })

  it('先完成的独立分支在另一分支返工后保留，事件时间不倒退', async () => {
    const api = harness()
    const workflow = (await api.call<Workflow>('/workflows', 'POST', {
      name: '分支交付', nodes: [
        { id: 'draft', name: '草案', type: 'agent', roleId: 'role-product' },
        { id: 'review', name: '审批', type: 'approval' },
        { id: 'docs', name: '文档', type: 'agent', roleId: 'role-writer' },
      ], edges: [{ source: 'draft', target: 'review' }],
    })).data
    const run = (await api.call<Run>('/runs', 'POST', { workflowId: workflow.id, input: '并行处理资料' })).data
    vi.setSystemTime(start + 2000)
    await api.call(`/runs/${run.id}`)
    vi.setSystemTime(start + 3000)
    const rejected = (await api.call<Run>(`/runs/${run.id}/reject`, 'POST', { targetNodeId: 'draft' })).data
    expect(rejected.nodes.find(node => node.id === 'docs')?.status).toBe('succeeded')
    vi.setSystemTime(start + 5000)
    await api.call(`/runs/${run.id}`)
    const final = (await api.call<Run>(`/runs/${run.id}/approve`, 'POST')).data
    expect(final.status).toBe('succeeded')
    expect(final.events.map(item => item.at)).toEqual([...final.events.map(item => item.at)].sort())
    expect((await api.call<Artifact[]>(`/artifacts?runId=${run.id}&attempt=1`)).data).toHaveLength(2)
    expect((await api.call<Artifact[]>(`/artifacts?runId=${run.id}&attempt=2`)).data).toHaveLength(1)
  })

  it('损坏的存储可恢复种子', async () => {
    const storage = memoryStorage()
    storage.setItem(STORAGE_KEY, '{')
    expect((await harness(storage).call<Role[]>('/roles')).data).toHaveLength(4)
  })
})
