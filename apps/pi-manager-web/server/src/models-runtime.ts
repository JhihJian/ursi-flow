import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultStateFile } from './homes.ts'
import { loadSdk } from './sdk.ts'

/**
 * 真实模型目录（context / maxTokens / reasoning / 图片输入）。
 *
 * 这些信息只有 pi 的 ModelRuntime 知道：内置目录来自 pi 的 catalog 缓存，自建
 * provider 来自 models.json，而扩展注册的 provider（extensions/providers/）根本
 * 不落任何配置文件——`sub2api-local` 的 29 个模型在磁盘上找不到元数据。
 *
 * 因此这里按需起一个**内存会话**：DefaultResourceLoader 加载该 home 的扩展，
 * 扩展调用 registerProvider 之后 ModelRuntime 里就有完整模型表。会话用
 * SessionManager.inMemory()，不写 sessions/ 目录，读完即 dispose。
 *
 * 代价与边界：
 * - 会执行该 home 的扩展代码（provider 扩展会访问网关），所以只在刷新时做，
 *   不在每次页面加载做；结果按 home 缓存到状态目录。
 * - 不创建交互会话、不驻留、不 spawn MCP server（noTools 全部关闭）。
 * - SDK 未安装时返回 null，配置管理其余部分照常可用。
 */

/** 一份模型元数据（字段对齐 pi `--list-models` 的列）。 */
export interface RuntimeModel {
  provider: string
  id: string
  name: string | null
  contextWindow: number | null
  maxTokens: number | null
  reasoning: boolean | null
  /** 是否支持图片输入（input 里含 image）。 */
  images: boolean | null
  /** 每百万 token 的美元单价，缺元数据时为 null。 */
  cost: { input: number; output: number } | null
  /** 该模型接受的思考档位（pi `getSupportedThinkingLevels` 的口径）；老缓存里没有。 */
  thinkingLevels?: string[]
  /** 档位到供应商真实值的映射；没配过或老缓存时为 null。 */
  thinkingLevelMap?: Record<string, string | null> | null
}

export interface RuntimeProvider {
  id: string
  name: string
}

export interface RuntimeCatalog {
  /** 采集完成时间（毫秒时间戳）。 */
  fetchedAt: number
  /** 采集时用的 cwd：项目级扩展/模型发现与它有关。 */
  cwd: string
  /** 可用的模型（provider 已有可用凭据）；不含未鉴权的内置目录。 */
  models: RuntimeModel[]
  /** provider 显示名；老缓存没有该字段时按 id 显示。 */
  providers?: RuntimeProvider[]
}

/**
 * 思考档位与「该模型是否支持」的判定。
 *
 * 与 pi-ai 的 `getSupportedThinkingLevels` 同一条规则：不支持思考的模型只有 `off`；
 * `xhigh`/`max` 只在该模型显式映射过时出现；映射为 null 表示不支持。
 * 这里复刻而不是 import：管理台只声明了 pi-coding-agent 一个依赖。
 */
const THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function supportedThinkingLevels(model: {
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null | undefined>
}): string[] {
  if (!model.reasoning) return ['off']
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * 缓存文件位置：与 homes.json 同一个状态目录（PI_MANAGER_STATE 指到文件，取它的
 * 目录部分），按 home + cwd 分键，跨重启稳定。
 */
function catalogFile(home: string, cwd: string): string {
  const stateFile = defaultStateFile()
  const base = join(dirname(stateFile), 'model-catalog')
  const key = createHash('sha256').update(`${home}\u0000${cwd}`).digest('hex').slice(0, 16)
  return join(base, `${key}.json`)
}

/** 读缓存；不存在或损坏都返回 null（页面据此提示刷新）。 */
export function readCachedCatalog(home: string, cwd: string): RuntimeCatalog | null {
  const file = catalogFile(home, cwd)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const catalog = parsed as RuntimeCatalog
    if (!Array.isArray(catalog.models) || typeof catalog.fetchedAt !== 'number') return null
    return catalog
  } catch {
    return null
  }
}

function writeCachedCatalog(home: string, cwd: string, catalog: RuntimeCatalog): void {
  const file = catalogFile(home, cwd)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
}

function toRuntimeModel(model: {
  provider: string
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: readonly string[]
  cost?: { input?: number; output?: number }
  thinkingLevelMap?: Record<string, string | null | undefined>
}): RuntimeModel {
  return {
    provider: model.provider,
    id: model.id,
    name: typeof model.name === 'string' && model.name !== model.id ? model.name : null,
    contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
    maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : null,
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
    images: Array.isArray(model.input) ? model.input.includes('image') : null,
    cost:
      model.cost && typeof model.cost.input === 'number' && typeof model.cost.output === 'number'
        ? { input: model.cost.input, output: model.cost.output }
        : null,
    thinkingLevels: supportedThinkingLevels(model),
    thinkingLevelMap: model.thinkingLevelMap
      ? Object.fromEntries(
          Object.entries(model.thinkingLevelMap).filter((entry): entry is [string, string | null] =>
            entry[1] === null || typeof entry[1] === 'string',
          ),
        )
      : null,
  }
}

/**
 * 起一个内存会话读真实模型目录并落缓存。失败（SDK 缺失、扩展报错）直接抛，
 * 由 API 层翻译成错误响应；缓存不写半成品。
 */
export async function refreshCatalog(home: string, cwd: string): Promise<RuntimeCatalog> {
  const sdk = await loadSdk()
  // 全部设置走内存实例：读目录不该改写该 home 的 settings.json，也不该触发
  // settings.packages 的 npm 安装（管理台不负责安装，安装是 pi CLI 的事）。
  const settingsManager = sdk.SettingsManager.inMemory({})
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: home, settingsManager })
  await loader.reload()
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: home,
    resourceLoader: loader,
    settingsManager,
    // 内存会话：不写 sessions/，与「执行一次性会话任务」区分开。
    sessionManager: sdk.SessionManager.inMemory(),
    // 目录查询不需要任何工具，也就不触发 MCP 与工具初始化。
    noTools: 'all',
  })
  try {
    const models = session.modelRuntime.getAvailableSnapshot().map(toRuntimeModel)
    const catalog: RuntimeCatalog = {
      fetchedAt: Date.now(),
      cwd,
      models: models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
      providers: session.modelRuntime.getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
      })),
    }
    writeCachedCatalog(home, cwd, catalog)
    return catalog
  } finally {
    session.dispose()
  }
}

/** 目录默认按服务进程的 cwd 采集：与「执行一次性会话任务」省略 cwd 时的行为一致。 */
export function catalogCwd(): string {
  return process.cwd()
}
