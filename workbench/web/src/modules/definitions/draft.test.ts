import { describe, expect, it } from 'vitest'
import type { Executor, Package, Resource } from './catalog'
import { initialDraft, publishBody } from './draft'
import { readDraft, writeDraft } from './draft-store'
import { normalizeConfigSchema } from './config'

const resource = (id: string): Resource => ({ id, revision: 2, kind: 'skill', content: '核查' })
const common = resource('common'), own = resource('own'), inherited = resource('inherited')
const exec: Executor = { id: 'pi', revision: 1, resources: [{ id: inherited.id, revision: 2 }] }
const pkg: Package = { id: 'triage', revision: 7, goal: { topic: '核查' }, sop: 'sop', acceptance: '标准', inputs: { ticket: 'string' }, outputs: {},
  deliverables: ['交付 文件.txt'], resources: [{ id: common.id, revision: 2 }], actions: { inspect: { executor: exec, resources: [common, own, inherited] } } }
const wire = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('版本草稿', () => {
  it('只从固定执行器版本恢复包、动作、执行器三层引用，保留结构化目标与显式空声明', () => {
    const newer: Executor = { ...exec, revision: 3, resources: [] }
    expect(() => initialDraft(pkg, [newer])).toThrow('pi v1')
    const d = initialDraft(pkg, [newer, exec]); d.actions[0].inputs = []
    expect(wire(publishBody('packages', d))).toEqual({ id: pkg.id, goal: pkg.goal, sop: pkg.sop, acceptance: pkg.acceptance, deliverables: pkg.deliverables,
      inputs: pkg.inputs, outputs: {}, resources: pkg.resources, actions: { inspect: { executor: { id: 'pi', revision: 1 }, resources: [{ id: own.id, revision: 2 }], inputs: {} } } })
  })
  it('拒绝重复动作和字段名，避免对象化时覆盖先前输入', () => {
    const d = initialDraft(pkg, [exec]); d.actions.push(d.actions[0]); expect(() => publishBody('packages', d)).toThrow('重复')
    d.actions.pop(); d.inputs!.push(d.inputs![0]); expect(() => publishBody('packages', d)).toThrow('重复')
  })
  it('动态配置表单只随执行器发布 configSchema，不发布配置值或旧后端字段', () => {
    const d = initialDraft({ id: 'pi', revision: 1, configSchema: normalizeConfigSchema({ fields: [
      { key: 'endpoint', label: '地址', type: 'url', default: 'https://example.test' },
      { key: 'token', label: '令牌', type: 'secret', default: '***' },
    ] }) })
    expect(wire(publishBody('executors', d))).toEqual({ id: 'pi', resources: [], configSchema: d.configSchema })
    expect(JSON.stringify(publishBody('executors', d))).not.toMatch(/"(kind|environment|flowId|flowRevision|config)"/)
  })

  it('secret 不写入 sessionStorage，恢复草稿时也不会回显', () => {
    sessionStorage.clear()
    const d = initialDraft({ id: 'pi', revision: 1, configSchema: normalizeConfigSchema({ fields: [{ key: 'token', type: 'secret' }] }) })
    writeDraft('config-secret-test', d)
    expect(sessionStorage.getItem('config-secret-test')).not.toContain('private-token')
    expect(readDraft('config-secret-test')?.config).toEqual({})
  })

  it('MCP 只发命名引用，执行器只发固定资源与 schema', () => {
    const mcp = { id: 'tools', kind: 'mcp' as const, content: { serverRef: 'tools-auth', credentialRef: 'token-ref' } }
    expect(wire(publishBody('resources', initialDraft({ ...mcp, revision: 5 })))).toEqual(mcp)
    const d = initialDraft({ ...exec, configSchema: normalizeConfigSchema([{ key: 'mode', label: '模式', type: 'enum', options: ['safe'] }]) })
    expect(wire(publishBody('executors', d))).toEqual({ id: exec.id, resources: exec.resources, configSchema: d.configSchema })
  })
})
