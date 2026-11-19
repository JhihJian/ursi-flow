import type { Collection } from './catalog'
import { initialDraft, type Draft } from './draft'

/**
 * 未发布草稿只保存在当前标签页的 sessionStorage。
 * 用途是缺少依赖时先去目录补建，再回到编辑器继续填写；草稿从不提交给服务端。
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

/** 读回草稿时以空白草稿补齐缺失字段，避免旧格式或残缺条目破坏表单控件。 */
export function readDraft(key: string): Draft | null {
  const raw = storage()?.getItem(key)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Draft> | null
    if (!value || typeof value !== 'object' || !Array.isArray(value.actions)) return null
    const actions = value.actions.filter(a => a && typeof a.name === 'string' && a.executor && Array.isArray(a.resources))
    if (actions.length !== value.actions.length) return null
    return { ...initialDraft(undefined), ...value, actions }
  } catch {
    return null
  }
}

export function writeDraft(key: string, draft: Draft) {
  try {
    storage()?.setItem(key, JSON.stringify(draft))
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
