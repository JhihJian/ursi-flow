import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot } from './rw.ts'
import { parseJsonc } from './jsonc.ts'

/**
 * models.json（自定义提供商与模型）与 auth.json（凭据）。
 *
 * models.json 按 pi 的宽松加载器解析（BOM、// 注释）；写回输出纯 JSON，
 * 注释不保留（与 pi CLI 行为一致）。auth.json 的凭据永不原样返回浏览器。
 */

export interface ProviderView {
  name: string
  baseUrl: string
  apiKeyMasked: string | null
  hasApiKey: boolean
  modelCount: number
  /** 原样条目（apiKey 已遮蔽）。 */
  entry: Record<string, unknown>
}

export interface ModelsListing {
  path: string
  exists: boolean
  revision: string
  providers: ProviderView[]
  /** 写回会丢注释：读到的文件是否含注释（用于 UI 提示）。 */
  hadComments: boolean
}

export function modelsConfigPath(home: string): string {
  return join(home, 'models.json')
}

type ModelsData = Record<string, unknown>

export function readModels(home: string): ModelsListing {
  const path = modelsConfigPath(home)
  if (!existsSync(path)) {
    return { path, exists: false, revision: '', providers: [], hadComments: false }
  }
  let hadComments = false
  const snap = readSnapshotSync<ModelsData>(
    path,
    (text) => {
      hadComments = /(^|[^:"'])\/\/|\/\*/.test(text.slice(text.charCodeAt(0) === 0xfeff ? 1 : 0))
      const parsed = parseJsonc<unknown>(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('models.json 顶层必须是对象')
      }
      return parsed as ModelsData
    },
  )
  // models.json 形状：{ providers: { <name>: ProviderEntry } }
  const providersRoot = snap.data.providers
  const entries: Record<string, unknown> =
    providersRoot && typeof providersRoot === 'object' && !Array.isArray(providersRoot)
      ? (providersRoot as Record<string, unknown>)
      : {}
  const providers: ProviderView[] = []
  for (const [name, raw] of Object.entries(entries)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : null
    const models = entry.models
    providers.push({
      name,
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      hasApiKey: apiKey !== null && apiKey.length > 0,
      apiKeyMasked: apiKey ? maskSecret(apiKey) : null,
      modelCount: Array.isArray(models) ? models.length : models && typeof models === 'object' ? Object.keys(models).length : 0,
      entry: { ...entry, ...(apiKey ? { apiKey: maskSecret(apiKey) } : {}) },
    })
  }
  providers.sort((a, b) => a.name.localeCompare(b.name))
  return { path, exists: true, revision: snap.revision, providers, hadComments }
}

export async function writeModels(
  home: string,
  expectedRevision: string,
  providers: Record<string, unknown>,
): Promise<string> {
  const path = modelsConfigPath(home)
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify(providers, null, 2)}\n`)
  const fresh = readModels(home)
  return fresh.revision
}

/** 深比较（对象/数组按内容）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/**
 * models.json 合并写回：entries 值为 null 的键删除；对象条目里值等于占位符
 * "•••…" 的 apiKey 用文件里的原文还原（提交值与上次遮蔽一致才还原）。
 */
export async function mergeModels(
  home: string,
  expectedRevision: string,
  entries: Record<string, Record<string, unknown> | null>,
): Promise<string> {
  const path = modelsConfigPath(home)
  let base: Record<string, unknown> = {}
  let currentRoot: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      base = readSnapshotSync<Record<string, unknown>>(path, parseJsonc).data
      const root = base.providers
      currentRoot = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>) : {}
    } catch {
      base = {}
    }
  }
  // 原文（未遮蔽）条目，用于把提交里的掩码占位符还原。
  const originals = new Map(Object.entries(currentRoot))
  const nextRoot: Record<string, unknown> = { ...currentRoot }
  const next = { ...base, providers: nextRoot }
  for (const [name, entry] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      throw new ConflictError(`provider 名只能包含字母数字与 .-_：${name}`)
    }
    if (entry === null) {
      delete nextRoot[name]
      continue
    }
    const original = originals.get(name)
    if (original) {
      const merged = resolveMaskedApiKey(entry, original as Record<string, unknown>)
      // 条目整体没变（用户只看了详情）就不动它
      nextRoot[name] = deepEqual(merged, original) ? currentRoot[name] : merged
    } else {
      if (typeof entry.apiKey === 'string' && entry.apiKey.startsWith('•••')) {
        throw new ConflictError(`provider ${name} 含遮蔽占位符但文件里没有原值，请填写真实 key`)
      }
      nextRoot[name] = entry
    }
  }
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify(next, null, 2)}\n`)
  return readModels(home).revision
}

function resolveMaskedApiKey(
  submitted: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...submitted }
  const apiKey = out.apiKey
  if (typeof apiKey === 'string' && apiKey.startsWith('•••')) {
    const orig = original.apiKey
    // 提交值与原文的掩码一致才还原；否则视为用户输入的新 key。
    if (typeof orig === 'string' && maskSecret(orig) === apiKey) out.apiKey = orig
  }
  return out
}

// ---------------------------------------------------------------------------
// auth.json：只读 + 增改，永不回传原文。
// ---------------------------------------------------------------------------

export interface AuthEntryView {
  provider: string
  type: 'oauth' | 'api_key'
  /** 遮蔽后的凭据摘要（oauth 无摘要，只报存在）。 */
  masked: string | null
}

export interface AuthListing {
  path: string
  exists: boolean
  revision: string
  entries: AuthEntryView[]
}

export function authConfigPath(home: string): string {
  return join(home, 'auth.json')
}

type AuthData = Record<string, unknown>

export function readAuth(home: string): AuthListing {
  const path = authConfigPath(home)
  if (!existsSync(path)) {
    return { path, exists: false, revision: '', entries: [] }
  }
  const snap = readSnapshotSync<AuthData>(path, (text) => {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('auth.json 顶层必须是对象')
    }
    return parsed as AuthData
  })
  const entries: AuthEntryView[] = []
  for (const [provider, raw] of Object.entries(snap.data)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.api_key === 'string') {
      entries.push({ provider, type: 'api_key', masked: maskSecret(entry.api_key) })
    } else {
      entries.push({ provider, type: 'oauth', masked: null })
    }
  }
  entries.sort((a, b) => a.provider.localeCompare(b.provider))
  return { path, exists: true, revision: snap.revision, entries }
}

/** 设置一个 provider 的 API key（覆盖该 provider 的整条凭据）。 */
export async function setAuthApiKey(
  home: string,
  expectedRevision: string,
  provider: string,
  apiKey: string,
): Promise<string> {
  const path = authConfigPath(home)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(provider)) {
    throw new Error('provider 名只能包含字母数字与 .-_')
  }
  const current = existsSync(path) ? readAuth(home).revision : ''
  if (current && current !== expectedRevision) {
    throw new Error('auth.json 已被其他进程修改，请刷新后重试')
  }
  const data: AuthData = existsSync(path)
    ? (readSnapshotSync<AuthData>(path, JSON.parse).data)
    : {}
  data[provider] = { api_key: apiKey }
  await writeSnapshot(path, undefined, () => `${JSON.stringify(data, null, 2)}\n`)
  return readAuth(home).revision
}

export async function deleteAuthEntry(home: string, expectedRevision: string, provider: string): Promise<string> {
  const path = authConfigPath(home)
  const current = readAuth(home)
  if (!current.exists) throw new Error('auth.json 不存在')
  if (current.revision !== expectedRevision) {
    throw new Error('auth.json 已被其他进程修改，请刷新后重试')
  }
  const data = readSnapshotSync<AuthData>(path, JSON.parse).data
  delete data[provider]
  await writeSnapshot(path, undefined, () => `${JSON.stringify(data, null, 2)}\n`)
  return readAuth(home).revision
}

function maskSecret(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : ''
  return `•••${tail ? `（末4位 ${tail}）` : ''}`
}
