import { describe, expect, it } from 'vitest'
import type { Role } from '@/shared/api/types'
import { parseDefinition } from './definition'
const roles = [{ id: 'author' }] as Role[]
const nodes = [
  { id: 'start', name: '准备', type: 'agent', roleId: 'author' },
  { id: 'review', name: '审核', type: 'approval' },
  { id: 'finish', name: '交付', type: 'script', script: 'echo done' },
]
const parse = (value: unknown = nodes, edges: unknown = []) => parseDefinition(' 测试流程 ', ' 描述 ', JSON.stringify(value), JSON.stringify(edges), roles)
describe('工作流定义校验', () => {
  it('保留三个节点类型的配置和合法分支 DAG', () => {
    const result = parse(nodes, [{ source: 'start', target: 'review' }, { source: 'start', target: 'finish' }, { source: 'review', target: 'finish' }])
    expect(result.name).toBe('测试流程')
    expect(result.nodes).toEqual(nodes)
    expect(result.edges).toHaveLength(3)
  })
  it('定位必填、JSON、角色和脚本配置错误', () => {
    expect(() => parseDefinition(' ', '', '[]', '[]', roles)).toThrow('名称')
    expect(() => parseDefinition('流程', '', '[', '[]', roles)).toThrow('节点 JSON')
    expect(() => parse([])).toThrow('至少')
    expect(() => parse([{ ...nodes[0], roleId: 'missing' }])).toThrow('roleId')
    expect(() => parse([{ ...nodes[2], script: '' }])).toThrow('脚本')
  })
  it('拒绝重复标识、悬空连线、重复连线和循环', () => {
    expect(() => parse([nodes[0], nodes[0]])).toThrow('重复')
    expect(() => parse(nodes, [{ source: 'start', target: 'missing' }])).toThrow('已有节点')
    expect(() => parse(nodes, [{ source: 'start', target: 'review' }, { source: 'start', target: 'review' }])).toThrow('重复')
    expect(() => parse(nodes, [{ source: 'start', target: 'review' }, { source: 'review', target: 'start' }])).toThrow('循环')
    expect(() => parse(nodes, [{ source: 'start', target: 'start' }])).toThrow('循环')
  })
})
