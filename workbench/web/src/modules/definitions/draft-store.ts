import type { Collection } from './catalog'
import { initialDraft, type Draft } from './draft'
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
const ref = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { id?: unknown; revision?: unknown }
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number'
    ? { id: candidate.id, revision: candidate.revision }
    : null
}
const refs = (value: unknown) => Array.isArray(value) ? value.map(ref).filter((v): v is { id: string; revision: number } => v !== null) : []

function agentFields(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const a = value as Record<string, unknown>
  return { agent: { systemPrompt: text(a.systemPrompt, ''), modelProfile: text(a.modelProfile, ''),
    tools: Array.isArray(a.tools) ? a.tools.filter((id): id is string => typeof id === 'string') : [] } }
}

function persistedDraft(draft: Draft): Draft {
  // 显式白名单是这里的安全边界，不能用 spread 把未来新增的 secret 字段写入存储。
  const schema = normalizeConfigSchema(draft.configSchema)
  return {
    id: draft.id,
    resourceKind: draft.resourceKind,
    text: draft.text,
    serverRef: draft.serverRef,
    credentialRef: draft.credentialRef,
    ...agentFields(draft.agent),
    resources: refs(draft.resources),
    configSchema: schema,
    config: sanitizeConfigValues(schema, draft.config),
  }
}

/** 读回草稿时只恢复已知字段，防止旧格式或恶意 JSON 注入 secret 和未知配置。 */
export function readDraft(key: string): Draft | null {
  const raw = storage()?.getItem(key)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || typeof value !== 'object') return null
    const base = initialDraft(undefined)
    const schema = normalizeConfigSchema(value.configSchema)
    return {
      ...base,
      id: text(value.id, base.id),
      resourceKind: value.resourceKind === 'prompt' || value.resourceKind === 'mcp' ? value.resourceKind : base.resourceKind,
      text: text(value.text, base.text),
      serverRef: text(value.serverRef, base.serverRef),
      credentialRef: text(value.credentialRef, base.credentialRef),
      ...agentFields(value.agent),
      resources: refs(value.resources),
      configSchema: schema,
      config: sanitizeConfigValues(schema, value.config),
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
