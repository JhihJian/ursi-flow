import type { Connection, Role, Run, Workflow, WorkflowNode } from '@/shared/api/types'
import { clone, createSeed, type MockState } from './seed'

export const STORAGE_KEY = 'ursi-flow-demo-v1'
export interface MockStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface MockOptions { delay?: number }
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
function invalid(message: string): never { throw new HttpError(400, 'VALIDATION', message) }
function badWorkflow(message: string): never { throw new HttpError(400, 'INVALID_WORKFLOW', message) }
function conflict(message: string): never { throw new HttpError(409, 'INVALID_STATE', message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求内容必须为 JSON 对象。')
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || (required && !value.trim())) invalid(`${field}不能为空且必须为文本。`)
  return value.trim()
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field}必须为数组。`)
  return value
}
function safeUrl(value: unknown, field: string): string {
  const raw = text(value, field, true)
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid(`${field}必须为不含内嵌凭据的 HTTP(S) 地址。`)
    if ([...url.searchParams.keys()].some(key => /token|key|secret|password|authorization/i.test(key))) invalid(`${field}不能包含凭据参数。`)
  } catch (error) {
    if (error instanceof HttpError) throw error
    invalid(`${field}不是有效地址。`)
  }
  return raw
}
function rejectCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:token|api_?key|access_?token|refresh_?token|password|secret|authorization|credential)$/i.test(key)) invalid('演示服务只接受凭据引用 credentialRef，不能保存凭据明文。')
    rejectCredentials(item)
  }
}
function find<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find(entry => entry.id === id)
  if (!item) throw new HttpError(404, 'NOT_FOUND', '请求的记录不存在。')
  return item
}
const iso = (now: number) => new Date(now).toISOString()
const active = (run: Run) => ['queued', 'running', 'waiting'].includes(run.status)
const uid = (state: MockState, prefix: string) => `${prefix}-${++state.sequence}`
function event(run: Run, now: number, message: string, nodeId?: string, type: 'state' | 'log' | 'tool' = 'state'): void {
  const at = iso(Math.max(now, Date.parse(run.updatedAt)))
  run.events.push({ id: `${run.id}-event-${String(run.events.length + 1).padStart(6, '0')}`, at, type, message, ...(nodeId ? { nodeId } : {}) })
  run.updatedAt = at
}

function validateConnection(data: Record<string, unknown>, id: string, now: number): Connection {
  rejectCredentials(data)
  return { id, name: text(data.name, '连接名称', true), provider: text(data.provider, '服务商', true), baseUrl: safeUrl(data.baseUrl, '服务地址'), model: text(data.model, '模型', true), credentialRef: text(data.credentialRef, '凭据引用'), updatedAt: iso(now) }
}
function validateRole(data: Record<string, unknown>, id: string, state: MockState, now: number): Role {
  rejectCredentials(data)
  const connectionId = text(data.connectionId, '模型连接', true)
  if (!state.connections.some(connection => connection.id === connectionId)) invalid('所选模型连接不存在。')
  const skills = array(data.skills ?? [], '技能').map(value => {
    const item = object(value)
    return { name: text(item.name, '技能名称', true), content: text(item.content, '技能内容') }
  })
  const mcpServers: Role['mcpServers'] = array(data.mcpServers ?? [], 'MCP 配置').map(value => {
    const item = object(value)
    const name = text(item.name, 'MCP 名称', true)
    const credentialRef = text(item.credentialRef, '凭据引用')
    if (item.transport === 'http') return { name, transport: 'http', url: safeUrl(item.url, 'MCP 地址'), credentialRef }
    if (item.transport === 'stdio') return { name, transport: 'stdio', command: text(item.command, 'MCP 命令', true), credentialRef }
    return invalid('MCP 传输方式必须为 stdio 或 http。')
  })
  return { id, name: text(data.name, '角色名称', true), systemPrompt: text(data.systemPrompt, '系统提示词', true), description: text(data.description, '描述'), icon: text(data.icon, '图标') || '◎', color: text(data.color, '颜色') || '#6366f1', model: text(data.model, '模型', true), connectionId, executor: text(data.executor, '执行器') || 'claude-code', skills, mcpServers, updatedAt: iso(now) }
}
function validateWorkflow(data: Record<string, unknown>, id: string, state: MockState, now: number): Workflow {
  rejectCredentials(data)
  const name = text(data.name, '流程名称', true)
  const nodes: WorkflowNode[] = array(data.nodes, '流程节点').map(value => {
    const node = object(value)
    if (!['agent', 'approval', 'script'].includes(String(node.type))) badWorkflow('流程包含未知节点类型。')
    const roleId = text(node.roleId, '角色')
    if ((node.type === 'agent' && !roleId) || (roleId && !state.roles.some(role => role.id === roleId))) badWorkflow('流程引用了不存在的角色。')
    return { id: text(node.id, '节点标识', true), name: text(node.name, '节点名称', true), type: node.type as WorkflowNode['type'], ...(roleId ? { roleId } : {}), ...(node.type === 'script' ? { script: text(node.script, '脚本', true) } : {}) }
  })
  if (!nodes.length) badWorkflow('流程至少需要一个节点。')
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length) badWorkflow('节点标识不能重复。')
  const edges = array(data.edges, '流程连线').map(value => {
    const edge = object(value)
    const source = text(edge.source, '起点', true)
    const target = text(edge.target, '终点', true)
    if (!ids.has(source) || !ids.has(target) || source === target) badWorkflow('流程连线必须连接两个不同的已有节点。')
    return { source, target }
  })
  if (new Set(edges.map(edge => JSON.stringify([edge.source, edge.target]))).size !== edges.length) badWorkflow('流程连线不能重复。')
  const remaining = new Set(ids)
  while (remaining.size) {
    const ready = [...remaining].filter(nodeId => !edges.some(edge => edge.target === nodeId && remaining.has(edge.source)))
    if (!ready.length) badWorkflow('流程存在循环依赖。')
    ready.forEach(nodeId => remaining.delete(nodeId))
  }
  return { id, name, description: text(data.description, '描述'), nodes, edges, updatedAt: iso(now) }
}

function release(state: MockState, run: Run, now: number): void {
  const sandbox = find(state.sandboxes, run.sandboxId)
  if (sandbox.status === 'released') return
  sandbox.status = 'released'
  sandbox.logs.push(`${iso(now)} 模拟资源已释放。`)
}
function artifact(state: MockState, run: Run, node: Run['nodes'][number], now: number): void {
  const content = `# ${node.name}\n\n## 任务背景\n${run.input}\n\n## 处理结果\n已完成「${node.name}」的演示处理。\n\n- 依据流程「${run.workflowName}」的配置快照生成\n- 第 ${run.attempt} 次执行\n- 已整理关键结论与后续交付事项\n\n> 此内容为本地演示数据，未调用模型或执行脚本。\n`
  state.artifacts.push({ id: uid(state, 'artifact'), name: `${node.name}.md`, path: `/workspace/output/${encodeURIComponent(node.id)}-attempt-${run.attempt}.md`, contentType: 'text/markdown', content, runId: run.id, nodeId: node.id, attempt: run.attempt, size: new TextEncoder().encode(content).length, createdAt: iso(now) })
}
/** 只推进模拟时钟，脚本和工具均不实际执行。按依赖逐个调度，审批暂停整个运行。 */
function schedule(state: MockState, run: Run, now: number): void {
  if (run.nodes.some(node => node.status === 'waiting_approval')) {
    run.status = 'waiting'
    return
  }
  if (run.nodes.some(node => node.status === 'running')) {
    run.status = 'running'
    return
  }
  const clocks = state.clocks[run.id] ?? {}
  for (const node of run.nodes) {
    if (node.status !== 'pending') continue
    const dependencies = run.snapshot.workflow.edges.filter(edge => edge.target === node.id)
    if (!dependencies.every(edge => run.nodes.some(parent => parent.id === edge.source && parent.status === 'succeeded'))) continue
    if (node.type === 'approval') {
      node.status = 'waiting_approval'
      event(run, now, `「${node.name}」等待人工审批。`, node.id)
    } else {
      node.status = 'running'
      Object.defineProperty(clocks, node.id, { value: now, writable: true, enumerable: true, configurable: true })
      state.clocks[run.id] = clocks
      event(run, now, `开始处理「${node.name}」。`, node.id)
      event(run, now, '模拟工具：读取配置快照并准备工作材料。', node.id, 'tool')
    }
    break
  }
  const previous = run.status
  if (run.nodes.every(node => node.status === 'succeeded')) {
    run.status = 'succeeded'
    if (previous !== 'succeeded') {
      event(run, now, '全部节点执行完成，交付产物已保存。')
      release(state, run, now)
      delete state.clocks[run.id]
    }
  } else {
    run.status = run.nodes.some(node => node.status === 'waiting_approval') ? 'waiting' : 'running'
  }
}
function advance(state: MockState, run: Run, now: number): void {
  if (!active(run)) return
  schedule(state, run, now)
  while (active(run)) {
    const clocks = state.clocks[run.id] ?? {}
    const next = run.nodes.filter(node => node.status === 'running' && clocks[node.id] !== undefined && clocks[node.id]! + 2000 <= now)
      .sort((a, b) => clocks[a.id]! - clocks[b.id]!)[0]
    if (!next) break
    const finished = clocks[next.id]! + 2000
    next.status = 'succeeded'
    next.output = `已完成「${next.name}」，第 ${run.attempt} 次执行的结果已保存。`
    delete clocks[next.id]
    artifact(state, run, next, finished)
    event(run, finished, next.output, next.id, 'log')
    schedule(state, run, finished)
  }
}
function startRun(state: MockState, body: Record<string, unknown>, now: number): Run {
  rejectCredentials(body)
  const workflow = find(state.workflows, text(body.workflowId, '流程', true))
  validateWorkflow(workflow as unknown as Record<string, unknown>, workflow.id, state, now)
  const roles = state.roles.filter(role => workflow.nodes.some(node => node.roleId === role.id))
  const connections = state.connections.filter(connection => roles.some(role => role.connectionId === connection.id))
  const id = uid(state, 'run')
  const sandboxId = uid(state, 'sandbox')
  const run: Run = { id, name: text(body.name, '运行名称') || `${workflow.name} · 新运行`, workflowId: workflow.id, workflowName: workflow.name, status: 'queued', createdAt: iso(now), updatedAt: iso(now), attempt: 1, nodes: workflow.nodes.map(node => ({ id: node.id, name: node.name, type: node.type, status: 'pending', ...(node.roleId ? { roleId: node.roleId } : {}) })), snapshot: clone({ workflow, roles, connections }), events: [], sandboxId, input: text(body.input, '任务输入', true) }
  state.runs.unshift(run)
  state.sandboxes.unshift({ id: sandboxId, name: `${run.name} · 工作区`, runId: id, status: 'running', image: 'ursi/agent-workspace:demo', createdAt: iso(now), cpu: '2 vCPU', memory: '4 GiB', workspace: '/workspace', logs: [`${iso(now)} 模拟工作区已准备，未启动真实容器。`] })
  event(run, now, '运行已创建，配置快照已保存。')
  schedule(state, run, now)
  return run
}
function actOnRun(state: MockState, run: Run, action: string, body: Record<string, unknown>, now: number): Run {
  if (!['approve', 'reject', 'cancel'].includes(action)) throw new HttpError(404, 'NOT_FOUND', '操作不存在。')
  if (!active(run)) conflict('运行已经结束，无法执行此操作。')
  if (action === 'cancel') {
    run.status = 'cancelled'
    run.nodes.forEach(node => { if (['pending', 'running', 'waiting_approval'].includes(node.status)) node.status = 'cancelled' })
    event(run, now, '运行已取消。')
    release(state, run, now)
    delete state.clocks[run.id]
    return run
  }
  const approval = run.nodes.find(node => node.status === 'waiting_approval')
  if (!approval || run.status !== 'waiting') conflict('当前运行没有待处理的审批。')
  if (action === 'approve') {
    approval.status = 'succeeded'
    event(run, now, `已通过「${approval.name}」。`, approval.id)
    schedule(state, run, now)
    return run
  }
  const targetId = text(body.targetNodeId, '返工节点', true)
  const edges = run.snapshot.workflow.edges
  const ancestors = new Set<string>()
  const collectAncestors = (id: string) => {
    for (const edge of edges.filter(edge => edge.target === id)) {
      if (!ancestors.has(edge.source)) { ancestors.add(edge.source); collectAncestors(edge.source) }
    }
  }
  collectAncestors(approval.id)
  if (!ancestors.has(targetId)) invalid('返工目标必须是当前审批节点的上游祖先节点。')
  const affected = new Set([targetId])
  let changed = true
  while (changed) {
    changed = false
    for (const edge of edges) if (affected.has(edge.source) && !affected.has(edge.target)) { affected.add(edge.target); changed = true }
  }
  run.attempt++
  run.nodes.forEach(node => {
    if (!affected.has(node.id)) return
    node.status = 'pending'
    delete node.output
    if (state.clocks[run.id]) delete state.clocks[run.id]![node.id]
  })
  event(run, now, `审批打回至「${find(run.nodes, targetId).name}」，开始第 ${run.attempt} 次执行。`, approval.id)
  schedule(state, run, now)
  return run
}

function route(state: MockState, method: string, url: URL, body: Record<string, unknown>, now: number): { value?: unknown; status?: number } {
  const parts = url.pathname.slice(5).split('/').filter(Boolean).map(part => decodeURIComponent(part))
  const [resource, id, action] = parts
  if (parts.length > 3) throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
  if (resource === 'demo' && id === 'settings' && !action) {
    if (method === 'GET') return { value: state.settings }
    if (method === 'PUT') {
      if (typeof body.delay !== 'number' || !Number.isFinite(body.delay) || body.delay < 0 || body.delay > 30_000 || typeof body.failNext !== 'boolean') invalid('延迟需为 0 至 30000 毫秒，failNext 需为布尔值。')
      state.settings = { delay: body.delay, failNext: body.failNext }
      return { value: state.settings }
    }
  }
  if (resource === 'roles') {
    if (!id && method === 'GET') return { value: state.roles }
    if (!id && method === 'POST') {
      const role = validateRole(body, uid(state, 'role'), state, now)
      state.roles.push(role)
      return { value: role, status: 201 }
    }
    if (id) {
      const role = find(state.roles, id)
      if (action === 'copy' && method === 'POST') {
        const copy = { ...clone(role), id: uid(state, 'role'), name: `${role.name}（副本）`, updatedAt: iso(now) }
        state.roles.push(copy)
        return { value: copy, status: 201 }
      }
      if (!action && method === 'GET') return { value: role }
      if (!action && method === 'PUT') {
        const updated = validateRole({ ...role, ...body }, id, state, now)
        state.roles[state.roles.indexOf(role)] = updated
        return { value: updated }
      }
      if (!action && method === 'DELETE') {
        if (state.workflows.some(workflow => workflow.nodes.some(node => node.roleId === id))) throw new HttpError(409, 'REFERENCE_CONFLICT', '角色仍被流程引用，请先调整流程。')
        state.roles = state.roles.filter(entry => entry.id !== id)
        return { status: 204 }
      }
    }
  }
  if (resource === 'connections') {
    if (!id && method === 'GET') return { value: state.connections }
    if (!id && method === 'POST') {
      const connection = validateConnection(body, uid(state, 'connection'), now)
      state.connections.push(connection)
      return { value: connection, status: 201 }
    }
    if (id) {
      const connection = find(state.connections, id)
      if (action === 'test' && method === 'POST') return { value: { ok: true, message: '模拟连接验证成功', latency: state.settings.delay } }
      if (!action && method === 'GET') return { value: connection }
      if (!action && method === 'PUT') {
        const updated = validateConnection({ ...connection, ...body }, id, now)
        state.connections[state.connections.indexOf(connection)] = updated
        return { value: updated }
      }
      if (!action && method === 'DELETE') {
        if (state.roles.some(role => role.connectionId === id)) throw new HttpError(409, 'REFERENCE_CONFLICT', '连接仍被角色引用，请先调整角色。')
        state.connections = state.connections.filter(entry => entry.id !== id)
        return { status: 204 }
      }
    }
  }
  if (resource === 'workflows') {
    if (!id && method === 'GET') return { value: state.workflows }
    if (!id && method === 'POST') {
      const workflow = validateWorkflow(body, uid(state, 'workflow'), state, now)
      state.workflows.push(workflow)
      return { value: workflow, status: 201 }
    }
    if (id) {
      const workflow = find(state.workflows, id)
      if (action === 'copy' && method === 'POST') {
        const copy = { ...clone(workflow), id: uid(state, 'workflow'), name: `${workflow.name}（副本）`, updatedAt: iso(now) }
        state.workflows.push(copy)
        return { value: copy, status: 201 }
      }
      if (!action && method === 'GET') return { value: workflow }
      if (!action && method === 'PUT') {
        const updated = validateWorkflow({ ...workflow, ...body }, id, state, now)
        state.workflows[state.workflows.indexOf(workflow)] = updated
        return { value: updated }
      }
      if (!action && method === 'DELETE') {
        state.workflows = state.workflows.filter(entry => entry.id !== id)
        return { status: 204 }
      }
    }
  }
  if (resource === 'runs') {
    if (!id && method === 'GET') { state.runs.forEach(run => advance(state, run, now)); return { value: state.runs } }
    if (!id && method === 'POST') return { value: startRun(state, body, now), status: 201 }
    if (id) {
      const run = find(state.runs, id)
      if (!action && method === 'GET') { advance(state, run, now); return { value: run } }
      if (action && method === 'POST') return { value: actOnRun(state, run, action, body, now) }
    }
  }
  if (resource === 'artifacts' && method === 'GET' && !action) {
    if (id) return { value: find(state.artifacts, id) }
    const runId = url.searchParams.get('runId')
    const attempt = url.searchParams.get('attempt')
    if (attempt !== null && (!/^\d+$/.test(attempt) || Number(attempt) < 1)) invalid('执行轮次必须为正整数。')
    return { value: state.artifacts.filter(item => (!runId || item.runId === runId) && (attempt === null || item.attempt === Number(attempt))) }
  }
  if (resource === 'sandboxes') {
    if (!id && method === 'GET') return { value: state.sandboxes }
    if (id) {
      const sandbox = find(state.sandboxes, id)
      if (!action && method === 'GET') return { value: sandbox }
      if (action === 'release' && method === 'POST') {
        const run = find(state.runs, sandbox.runId)
        if (active(run)) conflict('运行尚未结束，不能释放工作区。')
        release(state, run, now)
        return { value: sandbox }
      }
    }
  }
  throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('请求已取消。', 'AbortError')); return }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('请求已取消。', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
/** 可独立注入内存存储测试，无浏览器全局依赖。写操作在完整验证后一次提交。 */
export function createMockBackend(storage?: MockStorage, options: MockOptions = {}) {
  const initialDelay = options.delay ?? 180
  let state = createSeed(Date.now(), initialDelay)
  let restored = false
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (raw) {
        const loaded: unknown = JSON.parse(raw)
        const candidate = object(loaded)
        // 固定版本的完整状态才恢复，损坏的存储由全新演示数据恢复。
        const settings = object(candidate.settings)
        if (['roles', 'connections', 'workflows', 'runs', 'artifacts', 'sandboxes'].every(key => Array.isArray(candidate[key])) && Number.isSafeInteger(candidate.sequence) && typeof settings.delay === 'number' && Number.isFinite(settings.delay) && settings.delay >= 0 && settings.delay <= 30_000 && typeof settings.failNext === 'boolean' && candidate.clocks && typeof candidate.clocks === 'object') {
          state = loaded as MockState
          restored = true
        }
      }
    } catch { /* 存储不可读或 JSON 损坏时使用独立种子。 */ }
  }
  if (storage && !restored) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* 后续编辑仍会报告持久化失败。 */ }
  }
  function commit(next: MockState): void {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next))
    state = next
  }
  function reset(): void { commit(createSeed(Date.now(), initialDelay)) }
  const mockFetch: typeof fetch = async (input, init) => {
    const request = typeof input === 'object' && 'url' in input ? input as Request : undefined
    const rawUrl = request ? request.url : String(input)
    const url = new URL(rawUrl, 'http://mock.local')
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const signal = init?.signal ?? request?.signal
    await wait(state.settings.delay, signal)
    try {
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', '接口不存在。')
      const controls = /^\/api\/demo\/(?:settings|reset)\/?$/.test(url.pathname)
      if (!controls && state.settings.failNext) {
        const next = clone(state)
        next.settings.failNext = false
        commit(next)
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', '模拟服务暂时不可用，请重试。')
      }
      let body: Record<string, unknown> = {}
      const raw = init?.body !== undefined ? await new Response(init.body).text() : request && !['GET', 'HEAD'].includes(method) ? await request.clone().text() : ''
      if (signal?.aborted) throw new DOMException('请求已取消。', 'AbortError')
      if (raw) {
        try { body = object(JSON.parse(raw)) } catch (error) {
          if (error instanceof HttpError) throw error
          invalid('请求内容不是有效的 JSON。')
        }
      }
      if (method === 'POST' && /^\/api\/demo\/reset\/?$/.test(url.pathname)) { reset(); return json({ ok: true }) }
      const next = clone(state)
      const result = route(next, method, url, body, Date.now())
      if (JSON.stringify(next) !== JSON.stringify(state)) commit(next)
      return result.status === 204 ? new Response(null, { status: 204 }) : json(result.value, result.status)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status)
      return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '演示数据暂时无法读取或保存。' } }, 503)
    }
  }
  return { fetch: mockFetch, reset }
}
