import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HomeError } from '../shared/pi-home.ts'
import { loadSdk } from '../shared/sdk.ts'

/**
 * 模型连通性测试与上游模型发现（对齐 pi-web 的 models-config test / discover）。
 *
 * 两者都是显式用户动作，不在页面加载时执行：
 * - test 用临时 models.json + 该 home 的 auth.json 建一个 ModelRuntime，发一次
 *   16 token 的请求。不改写该 home 的 models.json，bounded 20s。
 * - discover 直接请求 provider 的 /models 端点，返回可追加到 models 数组的条目。
 */

const TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 该 home 的 auth.json 里这个 provider 的条目（只读）。 */
function authEntryOf(home: string, provider: string): Record<string, unknown> | null {
  const path = join(home, 'auth.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const entry = parsed[provider]
    return isRecord(entry) ? entry : null
  } catch {
    return null
  }
}

export interface ProbeResult {
  ok: boolean
  error?: string
  latencyMs?: number
  status?: number
  responseText?: string
}

/** 用临时 models.json 测一个 model：会发一次真实请求，凭据来自该 home 的 auth.json。 */
export async function testProviderModel(
  home: string,
  providerName: string,
  provider: Record<string, unknown>,
  model: Record<string, unknown>,
): Promise<ProbeResult> {
  const modelId = typeof model.id === 'string' ? model.id.trim() : ''
  if (!modelId) throw new HomeError('model.id 必填', 400, 'invalid_request')
  // 管理台不执行 !command 凭据：SDK 解析 auth 时会执行它取密钥。
  const authEntry = authEntryOf(home, providerName)
  if (typeof authEntry?.key === 'string' && authEntry.key.startsWith('!')) {
    return { ok: false, error: `${providerName} 的凭据是 !command 形式，管理台不执行命令取密钥` }
  }
  const sdk = await loadSdk()
  const tempDir = mkdtempSync(join(tmpdir(), 'pi-manager-model-test-'))
  const modelsPath = join(tempDir, 'models.json')
  writeFileSync(
    modelsPath,
    JSON.stringify(
      { providers: { [providerName]: { ...provider, models: [{ ...model, id: modelId }] } } },
      null,
      2,
    ),
    'utf8',
  )
  try {
    const runtime = await sdk.ModelRuntime.create({
      modelsPath,
      authPath: join(home, 'auth.json'),
      // 不复用该 home 的 models-store 缓存：测试只关心这一条草稿。
      refreshOnCreate: true,
    })
    const loadError = runtime.getError()
    if (loadError) return { ok: false, error: loadError }
    const resolved = runtime.getModel(providerName, modelId)
    if (!resolved) return { ok: false, error: `Model not found: ${providerName}/${modelId}` }
    // status 而不是 getAuth()：让请求自己解析凭据，!command 只执行一次。
    if (!runtime.getProviderAuthStatus(providerName).configured) {
      return { ok: false, error: `没有找到 ${providerName} 的可用凭据（auth.json 或条目里的 apiKey）` }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let status: number | undefined
    const startedAt = Date.now()
    try {
      const message = await runtime.completeSimple(
        resolved,
        { messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }] },
        {
          sessionId: randomUUID(),
          maxTokens: 16,
          timeoutMs: TIMEOUT_MS,
          maxRetries: 0,
          cacheRetention: 'none',
          signal: controller.signal,
          onResponse: (response: { status: number }) => {
            status = response.status
          },
        },
      )
      const latencyMs = Date.now() - startedAt
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        return {
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? '测试超时' : '模型返回错误'),
          latencyMs,
          status,
        }
      }
      const responseText = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      return { ok: true, latencyMs, status, responseText: responseText.slice(0, 300) }
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 上游模型发现
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
  id: string
  name?: string
  reasoning?: true
  thinkingLevelMap?: Partial<Record<string, string | null>>
  input?: string[]
  contextWindow?: number
  maxTokens?: number
}

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const CONTEXT_WINDOW_FIELDS = [
  'context_length', 'contextLength', 'context_window', 'contextWindow',
  'max_model_len', 'max_input_tokens', 'inputTokenLimit',
]
const MAX_TOKENS_FIELDS = ['max_output_tokens', 'maxOutputTokens', 'max_completion_tokens', 'outputTokenLimit']
const REASONING_FIELDS = ['supports_reasoning', 'supportsReasoning', 'reasoning', 'thinking']
const EFFORT_LIST_FIELDS = ['supported_efforts', 'supportedEfforts', 'reasoning_levels']
const INPUT_MODALITIES = new Set(['text', 'image'])

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstPositiveInteger(value: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const raw = value[field]
    const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) return number
  }
  return undefined
}

function inputFromValue(value: Record<string, unknown>): string[] | undefined {
  const modalities = value.modalities
  const list = isRecord(modalities) && Array.isArray(modalities.input)
    ? modalities.input
    : Array.isArray(value.input) ? value.input : undefined
  if (!list) return undefined
  const input = Array.from(new Set(
    list
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => INPUT_MODALITIES.has(entry)),
  ))
  return input.length ? input : undefined
}

function thinkingLevelMapFromEfforts(value: Record<string, unknown>): DiscoveredModel['thinkingLevelMap'] {
  const list = EFFORT_LIST_FIELDS.map((field) => value[field]).find(Array.isArray)
  if (!list) return undefined
  const advertised = new Set(list.filter((effort): effort is string => typeof effort === 'string'))
  if (!EFFORT_LEVELS.some((level) => advertised.has(level))) return undefined
  const map: NonNullable<DiscoveredModel['thinkingLevelMap']> = {}
  for (const level of EFFORT_LEVELS) {
    if (!advertised.has(level)) map[level] = null
    else if (level === 'xhigh' || level === 'max') map[level] = level
  }
  return map
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === 'string') {
    const id = value.trim()
    return id ? { id } : null
  }
  if (!isRecord(value)) return null
  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name)
  if (!rawId) return null
  const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId
  if (!id) return null
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined)
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true)
  const thinkingLevelMap = reasoning ? thinkingLevelMapFromEfforts(value) : undefined
  const input = inputFromValue(value)
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS)
  const maxTokens = firstPositiveInteger(value, MAX_TOKENS_FIELDS)
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(reasoning ? { reasoning: true as const } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(input ? { input } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  }
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  for (const key of ['data', 'models', 'results', 'items']) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate
    if (isRecord(candidate)) return Object.values(candidate)
  }
  return []
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models.sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

const GOOGLE_API_VERSION_SEGMENT = /\/v\d+(?:(?:alpha|beta)\d*)?$/i

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim())
  const trimmedPath = url.pathname.replace(/\/+$/, '')
  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath
    if (api === 'anthropic-messages' && !/\/v\d+(?:beta)?$/i.test(path)) path += '/v1'
    if (api === 'google-generative-ai' && !GOOGLE_API_VERSION_SEGMENT.test(path)) path += '/v1beta'
    url.pathname = `${path}/models`.replace(/\/+/g, '/')
  }
  return url
}

/** 从该 home 的 auth.json 取 provider 的 api_key（只读，不执行 !command）。 */
function authKeyOf(home: string, provider: string): string | undefined {
  const entry = authEntryOf(home, provider)
  if (!entry) return undefined
  if (entry.type !== undefined && entry.type !== 'api_key') return undefined
  const key = entry.key
  return typeof key === 'string' && key && !key.startsWith('!') ? key : undefined
}

/** 磁盘上该 provider 的条目；用于判断草稿的 baseUrl 是否仍是同一个目标。 */
function storedProvider(home: string, provider: string): Record<string, unknown> | null {
  const path = join(home, 'models.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const providers = parsed.providers
    if (!isRecord(providers)) return null
    const entry = providers[provider]
    return isRecord(entry) ? entry : null
  } catch {
    return null
  }
}

export interface DiscoveryResult {
  models: DiscoveredModel[]
  endpoint: string
}

/** 请求上游 /models；apiKey 依次取条目里的字面量、auth.json 的 api_key。 */
export async function discoverProviderModels(
  home: string,
  providerName: string,
  provider: Record<string, unknown>,
): Promise<DiscoveryResult> {
  const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : ''
  if (!baseUrl) throw new HomeError('Base URL 必填', 400, 'invalid_request')
  const api = typeof provider.api === 'string' && provider.api ? provider.api : 'openai-completions'
  const entryKey = typeof provider.apiKey === 'string' && provider.apiKey && !provider.apiKey.startsWith('•••')
    ? provider.apiKey
    : undefined
  // 磁盘上的 key 只在目标地址没变时使用，避免把凭据发到草稿里新填的 host。
  const stored = storedProvider(home, providerName)
  const storedBaseUrl = typeof stored?.baseUrl === 'string' ? stored.baseUrl.trim().replace(/\/+$/, '') : ''
  const sameTarget = baseUrl.replace(/\/+$/, '') === storedBaseUrl
  const apiKey = entryKey ?? (sameTarget ? authKeyOf(home, providerName) : undefined)

  let endpoint: URL
  try {
    endpoint = buildModelsListUrl(baseUrl, api)
  } catch {
    throw new HomeError('Base URL 不合法', 400, 'invalid_request')
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (isRecord(provider.headers)) {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value === 'string' && !value.includes('•••')) headers[key] = value
    }
  }
  if (apiKey) {
    if (api === 'anthropic-messages') {
      headers['x-api-key'] ??= apiKey
      headers['anthropic-version'] ??= '2023-06-01'
    } else if (api === 'google-generative-ai') {
      headers['x-goog-api-key'] ??= apiKey
    } else {
      headers.authorization ??= `Bearer ${apiKey}`
    }
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new HomeError(`请求上游模型列表失败：${errorMessage(error)}`, 502, 'discovery_failed')
  }
  const text = await response.text()
  if (!response.ok) {
    throw new HomeError(
      `上游返回 HTTP ${response.status}：${text.slice(0, 300) || '（空响应）'}`,
      502,
      'discovery_failed',
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new HomeError('上游模型列表不是合法 JSON', 502, 'discovery_failed')
  }
  const models = parseDiscoveredModels(payload)
  if (models.length === 0) throw new HomeError('上游响应里没有模型', 502, 'discovery_failed')
  return { models, endpoint: endpoint.toString() }
}
