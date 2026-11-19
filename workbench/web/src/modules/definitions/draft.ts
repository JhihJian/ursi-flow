import { pinned, sameRef, type Collection, type Definition, type Executor, type ExecutorKind, type Ports, type Ref, type ResourceKind } from './catalog'
import { configValuesForPublish, normalizeConfigSchema, sanitizeConfigValues, validateConfig, type ConfigSchema, type ConfigValues, type SecretConfigured, type SecretValues } from './config'

export type FieldRow = { name: string; type: string }
export type ActionDraft = { name: string; executor: Ref; resources: Ref[]; inputs?: FieldRow[]; outputs?: FieldRow[] }
export const blankRef = (): Ref => ({ id: '', revision: 0 })
export const blankAction = (): ActionDraft => ({ name: '', executor: blankRef(), resources: [] })
export type Draft = {
  id: string; resourceKind: ResourceKind; text: string; serverRef: string; credentialRef: string
  executorKind: ExecutorKind; environment: string; flowId: string; flowRevision: string
  resources: Ref[]; inputs?: FieldRow[]; outputs?: FieldRow[]
  configSchema: ConfigSchema; config: ConfigValues
  sop: string; acceptance: string; goal?: string; structuredGoal: boolean; deliverables?: string; actions: ActionDraft[]
}
const rows = (p?: Ports) => p && Object.entries(p).map(([name, type]) => ({ name, type }))
/** 交付物按行录入，忽略空行，保留顺序。 */
export function deliverableLines(text?: string) {
  return (text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
}
export function initialDraft(v?: Definition, executors: Executor[] = []): Draft {
  const d: Draft = {
    id: v?.id ?? '', resourceKind: 'skill', text: '', serverRef: '', credentialRef: '',
    executorKind: 'agent', environment: 'local', flowId: '', flowRevision: '', resources: [],
    configSchema: { fields: [] }, config: {},
    sop: '', acceptance: '', structuredGoal: false, actions: [blankAction()],
  }
  if (!v) return d
  if ('content' in v) {
    d.resourceKind = v.kind
    if (typeof v.content === 'string') d.text = v.content
    else { d.serverRef = v.content.serverRef; d.credentialRef = v.content.credentialRef ?? '' }
    return d
  }
  d.resources = (v.resources ?? []).map(pinned)
  if ('actions' in v) {
    d.inputs = rows(v.inputs); d.outputs = rows(v.outputs)
    d.sop = v.sop; d.acceptance = v.acceptance; d.deliverables = v.deliverables?.join('\n')
    d.structuredGoal = v.goal !== undefined && typeof v.goal !== 'string'
    d.goal = d.structuredGoal ? JSON.stringify(v.goal, null, 2) : v.goal as string | undefined
    d.actions = Object.entries(v.actions).map(([name, a]) => {
      const exec = executors.find(e => sameRef(e, a.executor))
      if (!exec) throw new Error(`缺少执行器 ${a.executor.id} v${a.executor.revision}，无法还原动作。`)
      const inherited = [...d.resources, ...(exec.resources ?? [])]
      return { name, executor: pinned(a.executor), resources: a.resources.filter(r => !inherited.some(i => sameRef(r, i))).map(pinned) }
    })
  } else {
    d.executorKind = v.kind; d.environment = v.environment === 'sandbox' ? 'sandbox' : 'local'
    d.flowId = v.flowId ?? ''; d.flowRevision = v.flowRevision ?? ''
    d.configSchema = normalizeConfigSchema(v.configSchema)
    d.config = sanitizeConfigValues(d.configSchema, v.config)
  }
  return d
}
function fields(portRows?: FieldRow[]) {
  if (!portRows) return undefined
  if (new Set(portRows.map(p => p.name)).size !== portRows.length) throw new Error('声明中有重复字段名。')
  return Object.fromEntries(portRows.map(p => [p.name, p.type]))
}
function fixed(ref: Ref) {
  if (!ref.id || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('请选择固定的引用版本。')
  return pinned(ref)
}
export function publishBody(k: Collection, d: Draft, secrets: SecretValues = {}, secretConfigured: SecretConfigured = {}, packageIds: readonly string[] = []) {
  const id = d.id
  if (k === 'resources') return { id, kind: d.resourceKind, content: d.resourceKind === 'mcp'
    ? { serverRef: d.serverRef, credentialRef: d.credentialRef || undefined } : d.text }
  if (k === 'executors') {
    const errors = validateConfig(d.configSchema, d.config, secrets, secretConfigured, packageIds)
    if (errors.length) throw new Error(errors[0])
    const config = configValuesForPublish(d.configSchema, d.config, secrets, secretConfigured)
    const base = d.executorKind === 'flow'
      ? { id, kind: 'flow', flowId: d.flowId, flowRevision: d.flowRevision }
      : { id, kind: 'agent', environment: d.environment === 'sandbox' ? 'sandbox' : 'local', resources: d.resources.map(fixed) }
    return Object.keys(config).length ? { ...base, config } : base
  }
  if (!id.trim()) throw new Error('请填写派工模板 ID。')
  const io = { inputs: fields(d.inputs), outputs: fields(d.outputs) }
  if (!d.sop.trim() || !d.acceptance.trim()) throw new Error('请填写办理说明和验收标准。')
  if (!d.actions.length || d.actions.some(a => !a.name.trim())) throw new Error('至少需要一个具名动作。')
  if (new Set(d.actions.map(a => a.name.trim())).size !== d.actions.length) throw new Error('动作名称不能重复，否则会覆盖先前的输入。')
  return { id, sop: d.sop, acceptance: d.acceptance, goal: d.structuredGoal ? JSON.parse(d.goal ?? '') : d.goal,
    deliverables: deliverableLines(d.deliverables), resources: d.resources.map(fixed), ...io,
    actions: Object.fromEntries(d.actions.map(a => [a.name.trim(), { executor: fixed(a.executor), resources: a.resources.map(fixed), inputs: fields(a.inputs), outputs: fields(a.outputs) }])),
  }
}
