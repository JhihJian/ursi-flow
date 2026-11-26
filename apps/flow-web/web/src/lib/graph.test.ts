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
    // 从上到下分层：层的先后体现在 y 上。
    expect(byKey.get('start')!.y).toBeLessThan(byKey.get('draft')!.y)
    expect(byKey.get('draft')!.y).toBeLessThan(byKey.get('review')!.y)
    expect(byKey.get('review')!.y).toBeLessThan(byKey.get('finish')!.y)
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

  it('回边与跨层边各走自己的车道，标签不互相遮挡', () => {
    // 复刻「Flow 运行观测能力开发」的形状：一条主链、多级回退、并行与跨层结束边。
    const nodes: FlowNodeView[] = [
      node('contract', '建立实现契约', [
        ['契约通过', { kind: 'node', ref: 'facts' }],
        ['需要重做', { kind: 'node', ref: 'contract' }],
      ]),
      node('facts', '补齐运行事实', [
        ['事实层完成', { kind: 'node', ref: 'inspector' }],
        ['需要调整契约', { kind: 'node', ref: 'contract' }],
      ]),
      node('inspector', '实现运行历史查询', [
        ['查询能力完成', { kind: 'node', ref: 'publisher' }],
        ['需要补齐运行事实', { kind: 'node', ref: 'facts' }],
      ]),
      node('publisher', '实现实时状态发布', [
        ['发布能力完成', { kind: 'node', ref: 'adapters' }],
        ['需要补齐查询能力', { kind: 'node', ref: 'inspector' }],
      ]),
      node('adapters', '接入外部展示形态', [
        ['展示能力完成', { kind: 'node', ref: 'prepare' }],
        ['需要补齐实时能力', { kind: 'node', ref: 'publisher' }],
      ]),
      node('prepare', '准备验收检查', [['开始检查', { kind: 'parallel', ref: 'checks' }]]),
      node('test', '运行测试', [['已执行', { kind: 'node', ref: 'merge' }]], 'command'),
      node('quality', '运行质量检查', [['已执行', { kind: 'node', ref: 'merge' }]], 'command'),
      node('merge', '汇总检查结果', [['已执行', { kind: 'node', ref: 'accept' }]], 'command'),
      node('accept', '执行验收门禁', [
        ['通过', { kind: 'finish' }],
        ['返工', { kind: 'node', ref: 'refine' }],
        ['无法验收', { kind: 'finish' }],
      ]),
      node('refine', '根据验收结果返工', [
        ['已返工', { kind: 'node', ref: 'prepare' }],
        ['无法安全返工', { kind: 'finish' }],
      ]),
    ]
    const layout = layoutFlow(
      detail(nodes, {
        startNodeRef: 'contract',
        parallels: [
          { ref: 'checks', branches: ['test', 'quality'], joinRef: 'merge', joinName: '汇总检查结果' },
        ],
      }),
    )

    const rect = (edge: (typeof layout.edges)[number]) => {
      const left =
        edge.labelAnchor === 'middle'
          ? edge.labelX - edge.labelWidth / 2
          : edge.labelAnchor === 'end'
            ? edge.labelX - edge.labelWidth
            : edge.labelX
      return {
        left,
        right: left + edge.labelWidth,
        top: edge.labelY,
        bottom: edge.labelY + edge.labelHeight,
        label: edge.label,
      }
    }
    const labels = layout.edges.filter((edge) => edge.label !== undefined).map(rect)
    expect(labels.length).toBeGreaterThan(10)

    // 任何两条边的线段都不重合：同一条水平线或垂直线上的重叠区段即失败。
    const segmentsOf = (path: string) => {
      const points = [...path.matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map((match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
      }))
      const segments: Array<{ axis: 'h' | 'v'; at: number; from: number; to: number; edge: string }> = []
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1]
        const b = points[index]
        const id = `${layout.edges.filter((edge) => edge.path === path)[0]?.from}->${layout.edges.filter((edge) => edge.path === path)[0]?.to}`
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5)
          segments.push({ axis: 'v', at: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y), edge: id })
        else if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) > 0.5)
          segments.push({ axis: 'h', at: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x), edge: id })
      }
      return segments
    }
    const segments = layout.edges.flatMap((edge) => segmentsOf(edge.path))
    for (let first = 0; first < segments.length; first += 1) {
      for (let second = first + 1; second < segments.length; second += 1) {
        const a = segments[first]
        const b = segments[second]
        if (a.axis !== b.axis || Math.abs(a.at - b.at) > 0.5) continue
        const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from)
        expect(overlap, `${a.edge} 与 ${b.edge} 在 ${a.axis} 方向重合`).toBeLessThanOrEqual(0.5)
      }
    }
    for (let first = 0; first < labels.length; first += 1) {
      for (let second = first + 1; second < labels.length; second += 1) {
        const a = labels[first]
        const b = labels[second]
        const overlaps =
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
        expect(overlaps, `${a.label} / ${b.label}`).toBe(false)
      }
    }

    // 连线不得与任何节点的边框重叠：留白车道与节点外框之间要有间距。
    const segmentsAll = layout.edges.flatMap((edge) => {
      const points = [...edge.path.matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map(
        (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
      )
      const out: Array<{ axis: 'h' | 'v'; at: number; from: number; to: number }> = []
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1]
        const b = points[index]
        if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5)
          out.push({ axis: 'v', at: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) })
        else if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) > 0.5)
          out.push({ axis: 'h', at: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x) })
      }
      return out
    })
    for (const segment of segmentsAll) {
      for (const item of layout.nodes) {
        const borders =
          segment.axis === 'v'
            ? [
                { at: item.x, from: item.y, to: item.y + item.height },
                { at: item.x + item.width, from: item.y, to: item.y + item.height },
              ]
            : [
                { at: item.y, from: item.x, to: item.x + item.width },
                { at: item.y + item.height, from: item.x, to: item.x + item.width },
              ]
        for (const border of borders) {
          if (Math.abs(segment.at - border.at) > 1) continue
          const overlap = Math.min(segment.to, border.to) - Math.max(segment.from, border.from)
          expect(overlap, `连线贴着节点 ${item.key} 的边框`).toBeLessThanOrEqual(1)
        }
      }
    }

    // 跨节点的回边全部走左侧留白：标签右对齐贴在各自车道内侧。
    const backs = layout.edges.filter(
      (edge) => edge.back && edge.from !== edge.to && edge.label !== undefined,
    )
    expect(backs.length).toBeGreaterThan(3)
    expect(backs.every((edge) => edge.labelAnchor === 'end')).toBe(true)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
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
