import type {
  FlowDetail,
  FlowNodeView,
  FlowValue,
  FlowVariables,
  LogEvent,
  RunStatus,
} from '../api'

/** 变量表单用字符串编辑，提交前按 JSON 优先解析，保持与命令行一致。 */
export type VariableDraft = Record<string, string>

export function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'awaiting_input':
      return '等待确认'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'unconfirmed':
      return '待核实'
    case 'interrupted':
      return '已停止'
  }
}

export type StatusTone = 'live' | 'wait' | 'done' | 'fail' | 'idle'

export function statusTone(status: RunStatus): StatusTone {
  if (status === 'running') return 'live'
  if (status === 'awaiting_input') return 'wait'
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'unconfirmed') return 'fail'
  return 'idle'
}

export function nodeKindLabel(kind: FlowNodeView['kind']): string {
  if (kind === 'confirm') return '确认'
  if (kind === 'command') return '命令'
  return 'Agent'
}

/** 表单初值：有默认值时按 JSON 写回，便于用户直接改数字与对象。 */
export function initialVariables(detail: FlowDetail | undefined): VariableDraft {
  if (detail === undefined) return {}
  return Object.fromEntries(
    detail.variables.map((variable) => [
      variable.name,
      variable.default === undefined ? '' : JSON.stringify(variable.default),
    ]),
  )
}

/** 空白输入视为未填写；填写内容先按 JSON 解析，失败时按字符串处理。 */
export function draftValue(raw: string): FlowValue | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isFlowValue(parsed) ? parsed : trimmed
  } catch {
    return trimmed
  }
}

export function buildVariables(detail: FlowDetail, draft: VariableDraft): FlowVariables {
  const variables: FlowVariables = {}
  for (const variable of detail.variables) {
    const value = draftValue(draft[variable.name] ?? '')
    if (value !== undefined) variables[variable.name] = value
  }
  return variables
}

/** 必填但没填写的变量名，用于禁用启动按钮并说明原因。 */
export function missingVariables(
  detail: FlowDetail,
  draft: VariableDraft,
): string[] {
  return detail.variables
    .filter((variable) => variable.required && (draft[variable.name] ?? '').trim() === '')
    .map((variable) => variable.name)
}

/** 解析失败时保留上次结果与错误原因的说明。 */
export function flowAvailability(detail: FlowDetail | undefined): string | null {
  if (detail === undefined) return '尚未选择 Flow'
  if (!detail.valid) return detail.error ?? 'Flow 定义无法解析'
  if (detail.nodes.length === 0) return 'Flow 没有任何节点'
  return null
}

/** 还能继续的运行：没到终点，且本进程没有在执行。 */
export function resumeDisabledReason(run: {
  status: RunStatus
  active: boolean
}): string | null {
  if (run.active) return '运行还在执行'
  if (run.status === 'completed') return '运行已经结束'
  if (run.status === 'failed') return '运行已失败，不能继续'
  return null
}

/** 还能停止的运行：只有未结束的才需要停止。 */
export function stopDisabledReason(run: {
  status: RunStatus
  active: boolean
}): string | null {
  if (run.active) return '运行还在执行'
  if (run.status === 'running') return null
  if (run.status === 'awaiting_input' || run.status === 'unconfirmed') return null
  return '运行已经结束'
}

export function outcomeLabel(outcome: {
  name: string
  destination: { kind: string; name?: string }
}): string {
  if (outcome.destination.kind === 'finish') return `${outcome.name} → 结束`
  if (outcome.destination.kind === 'parallel')
    return `${outcome.name} → 并行`
  return `${outcome.name} → ${outcome.destination.name ?? outcome.destination.kind}`
}

/** 过程事件按人读的顺序写一句话，界面不直接展示 JSON。 */
export function eventSummary(event: LogEvent): string {
  switch (event.type) {
    case 'run.started':
      return '开始运行'
    case 'node.entered':
      return `进入${event.nodeName ?? event.nodeRef ?? '节点'}`
    case 'parallel.entered':
      return '进入并行分支'
    case 'command.started':
      return `执行命令 ${event.nodeName ?? ''}`.trim()
    case 'command.finished':
      return `命令结束，退出码 ${event.exitCode ?? 0}`
    case 'agent.replied':
      return `回执 ${event.outcome ?? ''}`.trim()
    case 'agent.rejected':
      return `回执被拒：${event.reason ?? ''}`.trim()
    case 'confirm.pending':
      return '等待人工确认'
    case 'confirm.answered':
      return `人工确认 ${event.result ?? ''}`.trim()
    case 'route.selected':
      return `选边 ${event.outcome ?? ''}`.trim()
    case 'run.resumed':
      return `从快照继续（原状态 ${event.fromStatus ?? '未知'}）`
    case 'run.completed':
      return '运行完成'
    case 'run.failed':
      return `运行失败：${event.message ?? ''}`.trim()
    case 'run.unconfirmed':
      return `待核实：${event.message ?? ''}`.trim()
    case 'run.stopped':
      return '运行已停止'
    default:
      return event.type
  }
}

/**
 * 运行列表里的关键变量：按 Flow 声明的顺序取前几项，
 * 值压成一行，过长或太多时用省略号收尾。
 */
export function runVariableSummary(
  variables: Record<string, unknown>,
  names: string[],
  limit = 2,
): string {
  const entries = names
    .filter((name) => variables[name] !== undefined)
    .map((name) => `${name}=${previewValue(variables[name])}`)
  if (entries.length === 0) {
    const fallback = Object.entries(variables).map(
      ([name, value]) => `${name}=${previewValue(value)}`,
    )
    if (fallback.length === 0) return '无变量'
    const shown = fallback.slice(0, limit)
    return `${shown.join(' · ')}${fallback.length > shown.length ? ' …' : ''}`
  }
  const shown = entries.slice(0, limit)
  return `${shown.join(' · ')}${entries.length > shown.length ? ' …' : ''}`
}

function previewValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 24 ? `${value.slice(0, 23)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = JSON.stringify(value)
  return text.length > 24 ? `${text.slice(0, 23)}…` : text
}

export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export interface SidebarRailItem {
  label: string
  value: string
}

/** 折叠条上的关键信息：当前 Flow、运行中数量、包总数。 */
export function sidebarItems(input: {
  selectedName?: string
  running: number
  flowCount: number
}): SidebarRailItem[] {
  const items: SidebarRailItem[] = []
  if (input.selectedName !== undefined)
    items.push({ label: '当前', value: input.selectedName })
  items.push({ label: '运行中', value: String(input.running) })
  items.push({ label: 'Flow', value: String(input.flowCount) })
  return items
}

export function shortPath(path: string, home: string): string {
  if (home !== '' && path.startsWith(home)) {
    const rest = path.slice(home.length).replace(/^\//, '')
    return rest === '' ? '~' : `~/${rest}`
  }
  return path
}

function isFlowValue(value: unknown): value is FlowValue {
  if (value === null) return true
  if (['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isFlowValue)
  if (typeof value === 'object') return Object.values(value).every(isFlowValue)
  return false
}
