import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot } from './rw.ts'
import { parseJsonc } from './jsonc.ts'
import { HomeError } from './pi-home.ts'

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
// auth.json：条目级读写，凭据字段遮蔽后回显，原样提交即保留原文。
//
// pi 的凭据形状（dist/core/auth-storage.js 校验）：
//   api_key: { type: 'api_key', key?: string, env?: Record<string, string> }
//   oauth:   { type: 'oauth', access: string, refresh: string, expires: number }
// key 可以是 `!command` 形式（首次使用时执行），此处只标注、不执行。
// ---------------------------------------------------------------------------

export type AuthEntryType = 'oauth' | 'api_key' | 'unknown'

export interface AuthEntryView {
  provider: string
  type: AuthEntryType
  /** 遮蔽后的条目 JSON：key / access / refresh 显示为掩码。 */
  entry: Record<string, unknown>
  /** 被遮蔽的字段路径（用于 UI 提示哪些字段是凭据）。 */
  maskedFields: string[]
  /** oauth 的过期时间（epoch ms），仅 oauth 有。 */
  expires: number | null
  /** api_key 的 key 是 `!command` 形式：需要执行命令取密钥。 */
  keyCommand: string | null
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

const SECRET_FIELDS = new Set(['key', 'access', 'refresh'])

function authProviderName(provider: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(provider)) {
    throw new HomeError('provider 名只能包含字母数字与 .-_', 400, 'invalid_request')
  }
}

function entryType(entry: Record<string, unknown>): AuthEntryType {
  if (entry.type === 'api_key' || entry.type === 'oauth') return entry.type
  // 没有 type 但带 key 的旧式条目按 api_key 处理（与 pi 的宽容读取一致）。
  if (typeof entry.key === 'string') return 'api_key'
  return 'unknown'
}

function maskEntry(entry: Record<string, unknown>): { masked: Record<string, unknown>; fields: string[] } {
  const masked: Record<string, unknown> = {}
  const fields: string[] = []
  for (const [k, v] of Object.entries(entry)) {
    if (SECRET_FIELDS.has(k) && typeof v === 'string' && !v.startsWith('!')) {
      masked[k] = maskSecret(v)
      fields.push(k)
    } else {
      masked[k] = v
    }
  }
  return { masked, fields }
}

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
    const { masked, fields } = maskEntry(entry)
    const type = entryType(entry)
    entries.push({
      provider,
      type,
      entry: masked,
      maskedFields: fields,
      expires: typeof entry.expires === 'number' ? entry.expires : null,
      keyCommand: typeof entry.key === 'string' && entry.key.startsWith('!') ? entry.key : null,
    })
  }
  entries.sort((a, b) => a.provider.localeCompare(b.provider))
  return { path, exists: true, revision: snap.revision, entries }
}

/** 把提交里的掩码占位符还原成磁盘原文；用户改过则以提交为准。 */
function resolveAuthMasked(
  submitted: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(submitted)) {
    if (SECRET_FIELDS.has(k) && typeof v === 'string' && v.startsWith('•••')) {
      const orig = original[k]
      out[k] = typeof orig === 'string' && maskSecret(orig) === v ? orig : v
      continue
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const orig = original[k]
      out[k] =
        orig !== null && typeof orig === 'object' && !Array.isArray(orig)
          ? resolveAuthMasked(v as Record<string, unknown>, orig as Record<string, unknown>)
          : v
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * 合并写回：只改提交里出现的 provider，其余原样保留；值为 null 表示删除该条目。
 * 提交的掩码占位符按磁盘原文还原，改成新值则写新值。
 */
export async function mergeAuth(
  home: string,
  expectedRevision: string,
  entries: Record<string, Record<string, unknown> | null>,
): Promise<string> {
  const path = authConfigPath(home)
  let data: AuthData = {}
  if (existsSync(path)) {
    const snap = readSnapshotSync<AuthData>(path, (text) => {
      const parsed = JSON.parse(text) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('auth.json 顶层必须是对象')
      }
      return parsed as AuthData
    })
    if (expectedRevision && snap.revision !== expectedRevision) {
      throw new ConflictError('auth.json 已被其他进程修改，请刷新后重试')
    }
    data = snap.data
  } else if (expectedRevision) {
    throw new ConflictError('auth.json 不存在，请刷新后重试')
  }
  for (const [provider, submitted] of Object.entries(entries)) {
    authProviderName(provider)
    if (submitted === null) {
      delete data[provider]
      continue
    }
    const original =
      data[provider] !== null && typeof data[provider] === 'object' && !Array.isArray(data[provider])
        ? (data[provider] as Record<string, unknown>)
        : {}
    data[provider] = resolveAuthMasked(submitted, original)
  }
  await writeSnapshot(path, expectedRevision || undefined, () => `${JSON.stringify(data, null, 2)}\n`)
  return readAuth(home).revision
}

function maskSecret(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : ''
  return `•••${tail ? `（末4位 ${tail}）` : ''}`
}
