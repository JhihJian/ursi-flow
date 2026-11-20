import { describe, expect, it } from 'vitest'
import type { Executor } from './catalog'
import { initialDraft, publishBody } from './draft'
import { readDraft, writeDraft } from './draft-store'
import { normalizeConfigSchema } from './config'

const exec: Executor = { id: 'pi', revision: 1, resources: [{ id: 'guide', revision: 2 }] }
const wire = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('版本草稿', () => {
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
