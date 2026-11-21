import type { AgentConfig, AgentDefinition } from '@/shared/api/agent-executor'
import { pinned, type Collection, type Definition, type Ref, type ResourceKind } from './catalog'
import { configDefaults, normalizeConfigSchema, type ConfigSchema, type ConfigValues } from './config'

export const blankRef = (): Ref => ({ id: '', revision: 0 })
export type Draft = {
  id: string; resourceKind: ResourceKind; text: string; serverRef: string; credentialRef: string
  agent?: AgentConfig
  resources: Ref[]; configSchema: ConfigSchema; config: ConfigValues
}
export function initialDraft(v?: Definition): Draft {
  const d: Draft = {
    id: v?.id ?? '', resourceKind: 'skill', text: '', serverRef: '', credentialRef: '',
    resources: [], configSchema: { fields: [] }, config: {},
  }
  if (!v) return d
  if ('content' in v) {
    d.resourceKind = v.kind
    if (typeof v.content === 'string') d.text = v.content
    else { d.serverRef = v.content.serverRef; d.credentialRef = v.content.credentialRef ?? '' }
    return d
  }
  if (v.agent) {
    d.agent = { configPackageId: 'configPackageId' in v.agent ? v.agent.configPackageId : '' }
    return d
  }
  d.resources = (v.resources ?? []).map(pinned)
  d.configSchema = normalizeConfigSchema(v.configSchema)
  d.config = configDefaults(d.configSchema)
  return d
}
function fixed(ref: Ref) {
  if (!ref.id || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('请选择固定的引用版本。')
  return pinned(ref)
}
export function agentDefinition(id: string, { configPackageId }: AgentConfig): AgentDefinition {
  if (!configPackageId.trim()) throw new Error('请选择配置包。')
  return { id, agent: { configPackageId } }
}
export function publishBody(k: Collection, d: Draft) {
  const id = d.id
  if (k === 'resources') return { id, kind: d.resourceKind, content: d.resourceKind === 'mcp'
    ? { serverRef: d.serverRef, credentialRef: d.credentialRef || undefined } : d.text }
  if (d.agent) return agentDefinition(id, d.agent)
  return { id, resources: d.resources.map(fixed), ...(d.configSchema.fields.length ? { configSchema: d.configSchema } : {}) }
}
