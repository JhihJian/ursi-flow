import type { Collection } from './catalog'
import { initialDraft, type ActionDraft, type Draft, type FieldRow } from './draft'
import { normalizeConfigSchema, sanitizeConfigValues } from './config'

/**
 * 未发布草稿只保存在当前标签页的 sessionStorage。
 * secret 不属于 Draft 类型，也不会通过这里写入浏览器存储。
 */
const prefix = 'ursi-flow.definitions.draft'

export function draftKey(k: Collection, id?: string, revision?: string) {
  return `${prefix}:${k}:${id || 'new'}:${revision || 'draft'}`
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

const text = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback
const optionalText = (value: unknown) => typeof value === 'string' ? value : undefined
const ref = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { id?: unknown; revision?: unknown }
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number'
    ? { id: candidate.id, revision: candidate.revision }
    : null
}
const refs = (value: unknown) => Array.isArray(value) ? value.map(ref).filter((v): v is { id: string; revision: number } => v !== null) : []
const rows = (value: unknown): FieldRow[] | undefined => Array.isArray(value)
  ? value.filter((row): row is FieldRow => Boolean(row) && typeof row === 'object' && typeof (row as FieldRow).name === 'string' && typeof (row as FieldRow).type === 'string')
  : undefined
const actions = (value: unknown): ActionDraft[] | null => Array.isArray(value)
  ? value.map((action): ActionDraft | null => {
    if (!action || typeof action !== 'object') return null
    const candidate = action as Partial<ActionDraft>
    const executor = ref(candidate.executor)
    if (typeof candidate.name !== 'string' || !executor) return null
    const parsed: ActionDraft = { name: candidate.name, executor, resources: refs(candidate.resources) }
    const inputs = rows(candidate.inputs), outputs = rows(candidate.outputs)
    if (inputs !== undefined) parsed.inputs = inputs
    if (outputs !== undefined) parsed.outputs = outputs
    return parsed
  }).filter((v): v is ActionDraft => v !== null)
  : null

function persistedDraft(draft: Draft): Draft {
  // 显式白名单是这里的安全边界，不能用 spread 把未来新增的 secret 字段写入存储。
  const schema = normalizeConfigSchema(draft.configSchema)
  return {
    ...initialDraft(undefined),
    id: draft.id,
    resourceKind: draft.resourceKind,
    text: draft.text,
    serverRef: draft.serverRef,
    credentialRef: draft.credentialRef,
    executorKind: draft.executorKind,
    environment: draft.environment,
    flowId: draft.flowId,
    flowRevision: draft.flowRevision,
    resources: refs(draft.resources),
    inputs: rows(draft.inputs),
    outputs: rows(draft.outputs),
    configSchema: schema,
    config: sanitizeConfigValues(schema, draft.config),
    sop: draft.sop,
    acceptance: draft.acceptance,
    goal: draft.goal,
    structuredGoal: draft.structuredGoal,
    deliverables: draft.deliverables,
    actions: draft.actions,
  }
}

/** 读回草稿时只恢复已知字段，防止旧格式或恶意 JSON 注入 secret 和未知配置。 */
export function readDraft(key: string): Draft | null {
  const raw = storage()?.getItem(key)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    const actionList = actions(value.actions)
    if (!actionList?.length || actionList.length !== (Array.isArray(value.actions) ? value.actions.length : 0)) return null
    const base = initialDraft(undefined)
    const schema = normalizeConfigSchema(value.configSchema)
    return {
      ...base,
      id: text(value.id, base.id),
      resourceKind: value.resourceKind === 'prompt' || value.resourceKind === 'mcp' ? value.resourceKind : base.resourceKind,
      text: text(value.text, base.text),
      serverRef: text(value.serverRef, base.serverRef),
      credentialRef: text(value.credentialRef, base.credentialRef),
      executorKind: value.executorKind === 'flow' ? 'flow' : base.executorKind,
      environment: text(value.environment, base.environment),
      flowId: text(value.flowId, base.flowId),
      flowRevision: text(value.flowRevision, base.flowRevision),
      resources: refs(value.resources),
      inputs: rows(value.inputs),
      outputs: rows(value.outputs),
      configSchema: schema,
      config: sanitizeConfigValues(schema, value.config),
      sop: text(value.sop, base.sop),
      acceptance: text(value.acceptance, base.acceptance),
      goal: optionalText(value.goal),
      structuredGoal: value.structuredGoal === true,
      deliverables: optionalText(value.deliverables),
      actions: actionList,
    }
  } catch {
    return null
  }
}

export function writeDraft(key: string, draft: Draft) {
  try {
    storage()?.setItem(key, JSON.stringify(persistedDraft(draft)))
  } catch {
    // 存储不可用（隐私模式或超额）时不影响继续填写。
  }
}

export function clearDraft(key: string) {
  try {
    storage()?.removeItem(key)
  } catch {
    // 同 writeDraft。
  }
}
