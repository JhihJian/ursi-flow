import { describe, expect, it } from 'vitest'
import type { FlowDetail, FlowNodeView } from '../api'
import { layoutFlow } from './graph'

const node = (
  ref: string,
  name: string,
  outcomes: Array<[string, FlowNodeView['outcomes'][number]['destination']]>,
  kind: FlowNodeView['kind'] = 'agent',
): FlowNodeView => ({
  ref,
  name,
  kind,
  ...(kind === 'command' ? { request: { command: 'npm' } } : { prompt: `执行 ${name}` }),
  outcomes: outcomes.map(([outcome, destination]) => ({
    name: outcome,
    description: '',
    destination,
  })),
})

const detail = (nodes: FlowNodeView[], extras: Partial<FlowDetail> = {}): FlowDetail => ({
  id: 'demo',
  dir: '/home/me/.ursi/flow/demo',
  path: '/home/me/.ursi/flow/demo/FLOW.md',
  startNodeRef: nodes[0]?.ref ?? '',
  name: '示例',
  description: '',
  nodeCount: nodes.length,
  variableCount: 0,
  valid: true,
  variables: [],
  nodes,
  parallels: [],
  ...extras,
})

describe('结构图布局', () => {
  it('从起始节点开始，按结果边分层并加上结束节点', () => {
    const layout = layoutFlow(
      detail([
        node('draft', '起草', [['送审', { kind: 'node', ref: 'review', name: '审核' }]]),
        node('review', '审核', [['批准', { kind: 'finish' }]]),
      ]),
    )
    const byKey = new Map(layout.nodes.map((item) => [item.key, item]))
    expect(byKey.get('start')?.depth).toBe(0)
    expect(byKey.get('draft')?.depth).toBe(1)
    expect(byKey.get('review')?.depth).toBe(2)
    expect(byKey.get('finish')?.depth).toBe(3)
    expect(byKey.get('draft')!.x).toBeLessThan(byKey.get('review')!.x)
    expect(byKey.get('review')!.x).toBeLessThan(byKey.get('finish')!.x)
    expect(layout.edges.map((edge) => edge.label)).toContain('送审')
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('回到前面节点的结果边标成回边，不撑大层级', () => {
    const layout = layoutFlow(
      detail([
        node('change', '完成修改', [['已修改', { kind: 'node', ref: 'verify', name: '验证' }]]),
        node('verify', '验证', [
          ['通过', { kind: 'finish' }],
          ['返工', { kind: 'node', ref: 'change', name: '完成修改' }],
        ]),
      ]),
    )
    const back = layout.edges.find((edge) => edge.label === '返工')
    expect(back?.back).toBe(true)
    expect(layout.nodes.find((item) => item.key === 'change')?.depth).toBe(1)
    expect(layout.nodes.find((item) => item.key === 'verify')?.depth).toBe(2)
  })

  it('并行开始点单独成节点，分支入口带标签', () => {
    const layout = layoutFlow(
      detail(
        [
          node('prepare', '准备', [['已准备', { kind: 'parallel', ref: 'checks' }]]),
          node('test', '运行测试', [['已执行', { kind: 'node', ref: 'merge', name: '汇总' }]], 'command'),
          node('lint', '静态检查', [['已执行', { kind: 'node', ref: 'merge', name: '汇总' }]], 'command'),
          node('merge', '汇总', [['已执行', { kind: 'finish' }]], 'command'),
        ],
        {
          parallels: [
            { ref: 'checks', branches: ['test', 'lint'], joinRef: 'merge', joinName: '汇总' },
          ],
        },
      ),
    )
    const parallel = layout.nodes.find((item) => item.key === 'parallel:checks')
    expect(parallel?.kind).toBe('parallel')
    expect(parallel?.label).toBe('并行 · 2 支')
    const entries = layout.edges.filter((edge) => edge.from === 'parallel:checks')
    expect(entries.map((edge) => edge.to).sort()).toEqual(['lint', 'test'])
    expect(entries.every((edge) => edge.label === undefined)).toBe(true)
    expect(layout.nodes.find((item) => item.key === 'merge')?.kind).toBe('command')
  })

  it('长名字截断，孤立节点仍然出现在第一层', () => {
    const layout = layoutFlow(
      detail([
        node('main', '决定是否重新生成整个项目的结构说明与依赖清单', [
          ['完成', { kind: 'finish' }],
        ]),
        node('lonely', '孤立节点', [['完成', { kind: 'finish' }]]),
      ]),
    )
    const main = layout.nodes.find((item) => item.key === 'main')
    expect(main?.label.endsWith('…')).toBe(true)
    expect(main!.label.length).toBeLessThanOrEqual(14)
    expect(layout.nodes.find((item) => item.key === 'lonely')?.depth).toBe(1)
  })
})
