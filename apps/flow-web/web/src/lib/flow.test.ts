import { describe, expect, it } from 'vitest'
import type { FlowDetail, LogEvent } from '../api'
import {
  buildVariables,
  draftValue,
  eventSummary,
  flowAvailability,
  formatTime,
  initialVariables,
  missingVariables,
  nodeKindLabel,
  outcomeLabel,
  resumeDisabledReason,
  sidebarItems,
  statusLabel,
  statusTone,
  stopDisabledReason,
} from './flow'

const detail = (overrides: Partial<FlowDetail> = {}): FlowDetail => ({
  id: 'code-change',
  dir: '/home/me/.ursi/flow/code-change',
  path: '/home/me/.ursi/flow/code-change/FLOW.md',
  name: '代码修改',
  description: '改完再验证',
  nodeCount: 1,
  variableCount: 2,
  valid: true,
  variables: [
    { name: '任务', description: '本次目标', required: true },
    {
      name: '修改记录',
      description: '最新记录',
      required: false,
      default: '尚未修改',
    },
  ],
  nodes: [
    {
      ref: 'change',
      name: '完成修改',
      kind: 'agent',
      prompt: '改代码',
      outcomes: [{ name: '已修改', description: '', destination: { kind: 'finish' } }],
    },
  ],
  parallels: [],
  ...overrides,
})

describe('变量表单', () => {
  it('有默认值时写回 JSON，没有默认值时留空', () => {
    expect(initialVariables(detail())).toEqual({
      任务: '',
      修改记录: '"尚未修改"',
    })
    expect(initialVariables(undefined)).toEqual({})
  })

  it('提交前按 JSON 优先解析，失败时按字符串处理', () => {
    expect(draftValue('42')).toBe(42)
    expect(draftValue('true')).toBe(true)
    expect(draftValue('{"a":1}')).toEqual({ a: 1 })
    expect(draftValue('补一个测试')).toBe('补一个测试')
    expect(draftValue('  ')).toBeUndefined()
  })

  it('空值不进变量，必填缺失单独列出', () => {
    expect(buildVariables(detail(), { 任务: '补测试', 修改记录: '' })).toEqual({
      任务: '补测试',
    })
    expect(missingVariables(detail(), { 任务: ' ', 修改记录: 'x' })).toEqual(['任务'])
    expect(missingVariables(detail(), { 任务: 'x' })).toEqual([])
  })
})

describe('状态与文案', () => {
  it('运行状态有中文文案与色调', () => {
    expect(statusLabel('awaiting_input')).toBe('等待确认')
    expect(statusLabel('interrupted')).toBe('已停止')
    expect(statusTone('running')).toBe('live')
    expect(statusTone('awaiting_input')).toBe('wait')
    expect(statusTone('completed')).toBe('done')
    expect(statusTone('failed')).toBe('fail')
    expect(statusTone('interrupted')).toBe('idle')
  })

  it('节点类型与结果边写成一行', () => {
    expect(nodeKindLabel('agent')).toBe('Agent')
    expect(nodeKindLabel('confirm')).toBe('确认')
    expect(nodeKindLabel('command')).toBe('命令')
    expect(outcomeLabel({ name: '送审', destination: { kind: 'node', name: '审核' } })).toBe(
      '送审 → 审核',
    )
    expect(outcomeLabel({ name: '批准', destination: { kind: 'finish' } })).toBe(
      '批准 → 结束',
    )
  })

  it('过程事件转成人读的一句话', () => {
    const base = { seq: 1, at: '2024-01-01T00:00:00.000Z' }
    const events: LogEvent[] = [
      { ...base, type: 'run.started' },
      { ...base, type: 'node.entered', nodeName: '分析' },
      { ...base, type: 'agent.replied', outcome: '已分析' },
      { ...base, type: 'agent.rejected', reason: '不允许的结果' },
      { ...base, type: 'confirm.answered', result: '批准' },
      { ...base, type: 'route.selected', outcome: '批准' },
      { ...base, type: 'run.failed', message: '执行器出错' },
    ]
    expect(events.map(eventSummary)).toEqual([
      '开始运行',
      '进入分析',
      '回执 已分析',
      '回执被拒：不允许的结果',
      '人工确认 批准',
      '选边 批准',
      '运行失败：执行器出错',
    ])
  })

  it('只有没到终点的运行才能继续，只有未结束的运行才能停止', () => {
    expect(resumeDisabledReason({ status: 'completed', active: false })).toBe('运行已经结束')
    expect(resumeDisabledReason({ status: 'failed', active: false })).toBe('运行已失败，不能继续')
    expect(resumeDisabledReason({ status: 'awaiting_input', active: false })).toBeNull()
    expect(resumeDisabledReason({ status: 'interrupted', active: false })).toBeNull()
    expect(resumeDisabledReason({ status: 'awaiting_input', active: true })).toBe('运行还在执行')

    expect(stopDisabledReason({ status: 'completed', active: false })).toBe('运行已经结束')
    expect(stopDisabledReason({ status: 'failed', active: false })).toBe('运行已经结束')
    expect(stopDisabledReason({ status: 'interrupted', active: false })).toBe('运行已经结束')
    expect(stopDisabledReason({ status: 'awaiting_input', active: false })).toBeNull()
    expect(stopDisabledReason({ status: 'unconfirmed', active: false })).toBeNull()
    expect(stopDisabledReason({ status: 'running', active: false })).toBeNull()
    expect(stopDisabledReason({ status: 'running', active: true })).toBe('运行还在执行')
  })

  it('不可执行的 Flow 给出原因', () => {
    expect(flowAvailability(undefined)).toBe('尚未选择 Flow')
    expect(flowAvailability(detail())).toBeNull()
    expect(flowAvailability(detail({ valid: false, error: '缺少 FLOW.md' }))).toBe(
      '缺少 FLOW.md',
    )
  })

  it('折叠条给出当前 Flow、运行中数量与包总数', () => {
    expect(sidebarItems({ selectedName: '代码修改', running: 1, flowCount: 3 })).toEqual([
      { label: '当前', value: '代码修改' },
      { label: '运行中', value: '1' },
      { label: 'Flow', value: '3' },
    ])
    expect(sidebarItems({ running: 0, flowCount: 0 })).toEqual([
      { label: '运行中', value: '0' },
      { label: 'Flow', value: '0' },
    ])
  })

  it('时间格式化与非法输入兜底', () => {
    expect(formatTime(undefined)).toBe('-')
    expect(formatTime('2024-03-04T05:06:07.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(formatTime('not-a-date')).toBe('not-a-date')
  })
})
