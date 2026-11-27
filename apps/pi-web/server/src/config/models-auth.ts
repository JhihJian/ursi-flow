import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot } from '../shared/rw.ts'
import { parseJsonc } from '../shared/jsonc.ts'
import { HomeError } from '../shared/pi-home.ts'
import type { RuntimeCatalog, RuntimeModel } from './models-runtime.ts'
import { checkProviderEntry } from './models-check.ts'

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
    // 读不出就不允许覆盖：草稿不是从这份文件构建的。
    try {
      base = readSnapshotSync<Record<string, unknown>>(path, parseJsonc).data
    } catch {
      throw new ConflictError('models.json 无法解析，请先修复文件再保存')
    }
    const root = base.providers
    currentRoot = root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>) : {}
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
    const resolved = original
      ? resolveMaskedApiKey(entry, original as Record<string, unknown>)
      : entry
    if (!original && typeof entry.apiKey === 'string' && entry.apiKey.startsWith('•••')) {
      throw new ConflictError(`provider ${name} 含遮蔽占位符但文件里没有原值，请填写真实 key`)
    }
    checkProviderEntry(name, resolved)
    // 条目整体没变（用户只看了详情）就不动它
    nextRoot[name] = original && deepEqual(resolved, original) ? currentRoot[name] : resolved
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

/** 把草稿条目里的遮蔽 apiKey 用磁盘原文还原（测试连接 / 发现模型用）。 */
export function realProviderEntry(
  home: string,
  provider: string,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  const path = modelsConfigPath(home)
  if (!existsSync(path)) return submitted
  try {
    const data = readSnapshotSync<Record<string, unknown>>(path, parseJsonc).data
    const providers = data.providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return submitted
    const original = (providers as Record<string, unknown>)[provider]
    if (!original || typeof original !== 'object' || Array.isArray(original)) return submitted
    const originalEntry = original as Record<string, unknown>
    const sameHost = (value: unknown, other: unknown): boolean => {
      const a = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
      const b = typeof other === 'string' ? other.trim().replace(/\/+$/, '') : ''
      return a === '' || a === b
    }
    // 只有目标地址没变才用磁盘上的真实 key：草稿改成别的 host 时绝不外发已有凭据。
    if (!sameHost(submitted.baseUrl, originalEntry.baseUrl)) {
      const out = { ...submitted }
      // 只丢弃“占位符”形式的 key；用户自己输入的新 key 保留。
      if (typeof out.apiKey === 'string' && out.apiKey.startsWith('•••')) delete out.apiKey
      return out
    }
    return resolveMaskedApiKey(submitted, originalEntry)
  } catch {
    return submitted
  }
}

// ---------------------------------------------------------------------------
// models.json 的 modelOverrides：给内置或扩展提供的模型改元数据
//
// pi 的 models.json 支持 `providers.<provider>.modelOverrides.<modelId>`：只改
// contextWindow / maxTokens / reasoning / input 等字段，不替换 provider 的模型列表。
// 这是扩展注册的 provider（extensions/providers/）唯一的元数据配置入口——它们不写
// 任何配置文件，所以无法用 `models` 重建，只能覆盖。
// ---------------------------------------------------------------------------

/** 可由管理台写入的覆盖字段（其余字段原样保留，页面不编辑）。 */
export const OVERRIDABLE_FIELDS = ['contextWindow', 'maxTokens', 'reasoning', 'input'] as const
export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number]

/** 一个模型的覆盖条目：键是 modelId，值是 pi 的 modelOverrides 对象。 */
export type ModelOverrides = Record<string, Record<string, unknown>>

function overridesKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`.toLowerCase()
}

/** 读出全部生效中的 modelOverrides，按 `provider/modelId`（小写）索引。 */
export function readModelOverrides(home: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const path = modelsConfigPath(home)
  if (!existsSync(path)) return out
  let root: Record<string, unknown>
  try {
    root = readSnapshotSync<Record<string, unknown>>(path, parseJsonc).data
  } catch {
    return out
  }
  const providers = root.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return out
  for (const [provider, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const overrides = (rawEntry as Record<string, unknown>).modelOverrides
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) continue
    for (const [modelId, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      out.set(overridesKey(provider, modelId), value as Record<string, unknown>)
    }
  }
  return out
}

/**
 * 写一条 modelOverrides：override 为 null 表示删除该条覆盖。
 * 只触碰 `providers.<provider>.modelOverrides.<modelId>`，文件其余部分原样保留。
 */
export async function mergeModelOverride(
  home: string,
  expectedRevision: string,
  provider: string,
  modelId: string,
  override: Record<string, unknown> | null,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(provider)) {
    throw new HomeError(`provider 名只能包含字母数字与 .-_：${provider}`, 400, 'invalid_request')
  }
  if (!modelId.trim()) throw new HomeError('modelId 不能为空', 400, 'invalid_request')
  const path = modelsConfigPath(home)
  let base: Record<string, unknown> = {}
  if (existsSync(path)) {
    base = readSnapshotSync<Record<string, unknown>>(path, parseJsonc).data
  }
  const providersRoot = base.providers
  const providers: Record<string, unknown> =
    providersRoot && typeof providersRoot === 'object' && !Array.isArray(providersRoot)
      ? { ...(providersRoot as Record<string, unknown>) }
      : {}
  const existing = providers[provider]
  const entry: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const currentOverrides = entry.modelOverrides
  const overrides: Record<string, unknown> =
    currentOverrides && typeof currentOverrides === 'object' && !Array.isArray(currentOverrides)
      ? { ...(currentOverrides as Record<string, unknown>) }
      : {}

  if (override === null) {
    if (!(modelId in overrides)) return readModels(home).revision
    delete overrides[modelId]
  } else {
    const cleaned: Record<string, unknown> = { ...override }
    for (const field of OVERRIDABLE_FIELDS) {
      if (cleaned[field] === undefined) continue
      if (field === 'contextWindow' || field === 'maxTokens') {
        const value = cleaned[field]
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new HomeError(`${field} 必须是正数（token 数），收到 ${String(value)}`, 400, 'invalid_request')
        }
      }
      if (field === 'reasoning' && typeof cleaned[field] !== 'boolean') {
        throw new HomeError('reasoning 必须是布尔值', 400, 'invalid_request')
      }
      if (field === 'input') {
        const value = cleaned.input
        if (!Array.isArray(value) || value.some((v) => v !== 'text' && v !== 'image')) {
          throw new HomeError('input 只能是 text / image 组成的数组', 400, 'invalid_request')
        }
      }
    }
    overrides[modelId] = cleaned
  }

  // 只写了 modelOverrides 的条目是合法的：pi 用扩展或内置定义 provider，这里只覆盖模型。
  if (Object.keys(overrides).length > 0) entry.modelOverrides = overrides
  else delete entry.modelOverrides
  if (Object.keys(entry).length > 0) providers[provider] = entry
  else delete providers[provider]

  const next = { ...base, providers }
  await writeSnapshot(path, expectedRevision || undefined, () => `${JSON.stringify(next, null, 2)}\n`)
  return readModels(home).revision
}

/** models.json 的 apiKey 在列表回显时遮蔽，只留末 4 位提示。 */
function maskSecret(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : ''
  return `•••${tail ? `（末4位 ${tail}）` : ''}`
}

// ---------------------------------------------------------------------------
// models-store.json 与运行时目录
// ---------------------------------------------------------------------------

export interface StoreProviderView {
  provider: string
  modelCount: number
  /** 缓存时间（毫秒时间戳），未知为 null。 */
  checkedAt: number | null
  /** 前若干个模型 id，供页面展示目录规模。 */
  ids: string[]
}

/** 候选模型的来源标记。 */
export type CatalogSource =
  | 'settings.default'
  | 'settings.enabledModels'
  | 'models.json'
  | 'models-store.json'
  | 'runtime'

/**
 * 用于「启用模型」列表的一行：一个 provider/modelId 引用或一条模式。
 * 扩展注册的 provider（extensions/providers/）不写任何配置文件，只能靠
 * settings.json 里已有的条目或手写模式出现，因此 resolvable 会标 false。
 */
export interface CatalogCandidate {
  ref: string
  provider: string
  modelId: string
  sources: CatalogSource[]
  /** 是否含通配或可选 :thinking 后缀，语义上不是单个模型。 */
  pattern: boolean
  /** 目录里能否确认该模型存在（models.json / models-store.json / 运行时目录命中）。 */
  resolvable: boolean
  enabled: boolean
  /** 在 enabledModels 里的位置（0 起），未启用为 null。 */
  enabledIndex: number | null
  /** 模型显示名（运行时目录给的 name，与 id 相同时为 null）。 */
  displayName: string | null
  /** 上下文窗口（token），未知为 null。 */
  contextWindow: number | null
  /** 单次输出上限（token），未知为 null。 */
  maxTokens: number | null
  /** 是否支持思考。 */
  reasoning: boolean | null
  /** 是否支持图片输入。 */
  images: boolean | null
  /** 每百万 token 的美元单价，未知为 null。 */
  cost: { input: number; output: number } | null
  /** models.json 里该模型的 modelOverrides 原文（无覆盖为 null）。 */
  override: Record<string, unknown> | null
  /** 已被覆盖的字段名，供页面标「已覆盖」。 */
  overriddenFields: string[]
}

/**
 * enabledModels 的三种形态：
 * - all：key 不存在，pi 视为全部可用，所有候选都是启用状态。
 * - none：key 存在但是空数组（pi 的 clearAll + 保存就是这个形态）。pi 在
 *   /scoped-models 里把它归一成「全部可用」，本页按字面显示为全部停用。
 * - explicit：非空数组，按清单顺序决定循环与启动首选。
 */
export type ModelScope = 'all' | 'none' | 'explicit'

export interface ModelCatalog {
  /** settings.json 的 defaultProvider / defaultModel。 */
  configured: { provider: string | null; modelId: string | null }
  /** enabledModels 的形态，决定开关怎么显示、工具条按钮是「全部启用」还是「全部停用」。 */
  scope: ModelScope
  /** settings.json 的 enabledModels（模型循环清单，也是本机真实配置的模型来源）。 */
  enabledModels: string[]
  /** models.json 里自建 provider 名。 */
  modelsJsonProviders: string[]
  /** models-store.json 缓存的内置 provider 目录。 */
  store: StoreProviderView[]
  /** 全部已知 provider/modelId 引用，供页面补全。 */
  refs: string[]
  /** 启用模型列表的候选行：启用项按 enabledModels 顺序在前，其余按 provider/引用排序。 */
  candidates: CatalogCandidate[]
  /** 运行时目录的采集时间；未采集过为 null（页面据此提示刷新目录）。 */
  catalogFetchedAt: number | null
  /** 运行时目录覆盖到的 provider 数；未采集为 0。 */
  catalogProviders: number
  /** models.json 的 revision，写 modelOverrides 时作为乐观锁。 */
  modelsRevision: string
}

interface StoreProviderRaw {
  provider: string
  checkedAt: number | null
  ids: string[]
}

function readStoreProviders(home: string): StoreProviderRaw[] {
  const path = join(home, 'models-store.json')
  if (!existsSync(path)) return []
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    return []
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return []
  const out: StoreProviderRaw[] = []
  for (const [provider, raw] of Object.entries(data as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const models = Array.isArray(entry.models) ? entry.models : []
    const ids = models
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string')
    out.push({ provider, checkedAt: typeof entry.checkedAt === 'number' ? entry.checkedAt : null, ids })
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider))
  return out
}

/** models.json 里 provider 声明的模型 id。 */
function modelsJsonModelIds(entry: Record<string, unknown>): string[] {
  const models = entry.models
  if (Array.isArray(models)) {
    return models
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string')
  }
  if (models && typeof models === 'object') return Object.keys(models as Record<string, unknown>)
  return []
}

/** 通配符。模型 id 本身可以带 `:`（如 ollama 的 `qwen2.5-coder:7b`），不算模式。 */
const PATTERN_CHARS = /[*?[]/

function splitRef(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/')
  return slash < 0
    ? { provider: '', modelId: ref }
    : { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/** 本机模型清单：settings.json 的默认与启用模型 + models.json 自建 provider + 运行态目录缓存。 */
export function readModelCatalog(
  home: string,
  settings: Record<string, unknown>,
  runtimeCatalog: RuntimeCatalog | null = null,
): ModelCatalog {
  const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
  const modelId = typeof settings.defaultModel === 'string' ? settings.defaultModel : null
  const rawEnabled = settings.enabledModels
  const enabledModels = Array.isArray(rawEnabled)
    ? rawEnabled.filter((v): v is string => typeof v === 'string')
    : []
  const scope: ModelScope = !Array.isArray(rawEnabled) ? 'all' : enabledModels.length === 0 ? 'none' : 'explicit'
  const modelsFile = readModels(home)
  const modelsJson = modelsFile.providers
  const rawStore = readStoreProviders(home)

  // 运行时目录按 `provider/id` 索引，大小写不敏感查（网关返回的 id 大小写不统一）。
  const overrides = readModelOverrides(home)
  const runtimeById = new Map<string, RuntimeModel>()
  for (const model of runtimeCatalog?.models ?? []) {
    runtimeById.set(`${model.provider}/${model.id}`.toLowerCase(), model)
  }

  // 候选按 ref 归并，但大小写不同的写法算同一条：网关返回的 id 大小写不统一，
  // settings 里的写法是用户已确认过的，两者合并成一行而不是两行。
  const candidates = new Map<string, CatalogCandidate>()
  const add = (ref: string, source: CatalogSource, resolvable: boolean) => {
    const existing = candidates.get(ref) ?? candidates.get(ref.toLowerCase())
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      existing.resolvable ||= resolvable
      // 启用项沿用 settings.json 里的写法，写回时不会改大小写。
      if (source === 'settings.enabledModels' && existing.ref !== ref) {
        candidates.delete(ref.toLowerCase())
        const previousKey = existing.ref
        existing.ref = ref
        candidates.delete(previousKey)
        candidates.set(ref.toLowerCase(), existing)
      }
      return
    }
    const runtime = runtimeById.get(ref.toLowerCase()) ?? null
    const override = overrides.get(ref.toLowerCase()) ?? null
    // 生效值按 pi 的合并规则算：override 的标量字段直接替换，input 是数组整体替换。
    // 这样刚写完覆盖就能看到新值，不必等下一次目录采集。
    const overrideNumber = (field: string): number | null =>
      typeof override?.[field] === 'number' ? (override[field] as number) : null
    const overrideInput = Array.isArray(override?.input) ? (override.input as unknown[]) : null
    candidates.set(ref.toLowerCase(), {
      ref,
      ...splitRef(ref),
      sources: [source],
      pattern: PATTERN_CHARS.test(ref),
      resolvable: resolvable || runtime !== null,
      enabled: false,
      enabledIndex: null,
      displayName: typeof override?.name === 'string' ? override.name : (runtime?.name ?? null),
      contextWindow: overrideNumber('contextWindow') ?? runtime?.contextWindow ?? null,
      maxTokens: overrideNumber('maxTokens') ?? runtime?.maxTokens ?? null,
      reasoning:
        typeof override?.reasoning === 'boolean' ? override.reasoning : (runtime?.reasoning ?? null),
      images: overrideInput ? overrideInput.includes('image') : (runtime?.images ?? null),
      cost: runtime?.cost ?? null,
      override,
      overriddenFields: override ? Object.keys(override) : [],
    })
  }

  if (provider && modelId) add(`${provider}/${modelId}`, 'settings.default', false)
  for (const raw of modelsJson) {
    for (const id of modelsJsonModelIds(raw.entry)) add(`${raw.name}/${id}`, 'models.json', true)
  }
  // 运行时目录里的可用模型全部入列：这是 pi 的 /model 选择器能看到的集合，也是
  // 唯一包含扩展注册 provider 的来源。它存在时不再补 models-store 缓存（那是没有
  // 鉴权的内置目录，页面列出来也选不了），只在没采集过时兜底。
  if (runtimeCatalog) {
    for (const model of runtimeCatalog.models) add(`${model.provider}/${model.id}`, 'runtime', true)
  } else {
    for (const item of rawStore) for (const id of item.ids) add(`${item.provider}/${id}`, 'models-store.json', true)
  }
  // 已启用条目最后加入，保证 enabledIndex 取的是 settings 里的顺序。
  enabledModels.forEach((ref, index) => {
    add(ref, 'settings.enabledModels', false)
    const candidate = candidates.get(ref.toLowerCase())!
    candidate.enabled = true
    candidate.enabledIndex = index
  })
  // scope=all 表示 pi 里全部可用，没有顺序概念，全部标成启用。
  if (scope === 'all') for (const candidate of candidates.values()) candidate.enabled = true

  const byProvider = (a: CatalogCandidate, b: CatalogCandidate) =>
    a.provider.localeCompare(b.provider) || a.ref.localeCompare(b.ref)
  // 启用项改了 ref 写法后，provider/modelId 字段跟着同步。
  for (const candidate of candidates.values()) {
    const split = splitRef(candidate.ref)
    candidate.provider = split.provider
    candidate.modelId = split.modelId
  }

  const ordered = [...candidates.values()].sort((a, b) => {
    // 显式清单里按 settings 的顺序排；全部可用时没有顺序，按 provider 排免得跳动。
    if (a.enabled && b.enabled && a.enabledIndex !== null && b.enabledIndex !== null) {
      return a.enabledIndex - b.enabledIndex
    }
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return byProvider(a, b)
  })

  return {
    configured: { provider, modelId },
    scope,
    enabledModels,
    modelsJsonProviders: modelsJson.map((p) => p.name),
    store: rawStore.map((item) => ({
      provider: item.provider,
      modelCount: item.ids.length,
      checkedAt: item.checkedAt,
      ids: item.ids.slice(0, 8),
    })),
    refs: ordered.map((c) => c.ref).sort(),
    candidates: ordered,
    catalogFetchedAt: runtimeCatalog?.fetchedAt ?? null,
    catalogProviders: new Set((runtimeCatalog?.models ?? []).map((m) => m.provider)).size,
    modelsRevision: modelsFile.revision,
  }
}
