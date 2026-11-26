/**
 * 服务端 API 的响应/请求类型，与 server/src/api.ts 对齐。
 * 凭据字段一律是遮蔽后的字符串（服务端保证不回传原文）。
 */

export interface HomeDefaults {
  default: string | null
}

export interface HomeCheck {
  home: string
  valid: boolean
}

export type HomeSource = 'default' | 'env' | 'user' | 'manual'

/** 一个 pi home 的摘要：服务端清单条目 + 自动发现项。 */
export interface HomeSummary {
  id: string
  /** 用户定义的显示名。 */
  name: string
  description?: string
  path: string
  /** 是否在服务端清单里（清单条目可改名、移除）。 */
  listed: boolean
  valid: boolean
  sources: HomeSource[]
  skills: number
  agents: number
  mcpServers: number
  packages: number
  hasModels: boolean
  hasAuth: boolean
  error?: string
}

export interface HomesListing {
  homes: HomeSummary[]
}

/** 新增 pi home：登记已有目录 / 初始化默认配置 / 从另一份复制。 */
export type HomeCreateMode = 'adopt' | 'init' | 'clone'

export interface HomeCreateInput {
  mode: HomeCreateMode
  path: string
  name?: string
  /** clone 模式的来源 pi home 路径。 */
  from?: string
  /** clone 时是否一并复制 auth.json（默认不复制）。 */
  includeAuth?: boolean
}

export interface GeneralListing {
  revision: string
  path: string
  managed: Record<string, unknown>
  keyCount: number
  unmanagedKeys: string[]
}

export type CatalogSource =
  | 'settings.default'
  | 'settings.enabledModels'
  | 'models.json'
  | 'models-store.json'
  | 'runtime'

/** 启用模型列表的一行：一个 provider/modelId 引用或一条模式。 */
export interface CatalogCandidate {
  ref: string
  provider: string
  modelId: string
  sources: CatalogSource[]
  pattern: boolean
  resolvable: boolean
  enabled: boolean
  enabledIndex: number | null
  /** 运行时目录给的显示名（与 id 相同时为 null）。 */
  displayName: string | null
  /** 上下文窗口（token），未知为 null。 */
  contextWindow: number | null
  /** 单次输出上限（token），未知为 null。 */
  maxTokens: number | null
  reasoning: boolean | null
  images: boolean | null
  /** 每百万 token 的美元单价，未知为 null。 */
  cost: { input: number; output: number } | null
}

/** enabledModels 的三种形态：key 不存在 = 全部可用，空数组 = 按字面全部停用，非空 = 显式清单。 */
export type ModelScope = 'all' | 'none' | 'explicit'

/** 本机模型清单：文件级可见的 provider/模型来源（只读汇总）。 */
export interface ModelCatalog {
  configured: { provider: string | null; modelId: string | null }
  scope: ModelScope
  enabledModels: string[]
  modelsJsonProviders: string[]
  store: Array<{ provider: string; modelCount: number; checkedAt: number | null; ids: string[] }>
  refs: string[]
  candidates: CatalogCandidate[]
  /** 运行时目录采集时间；null 表示还没采集过（页面提示刷新）。 */
  catalogFetchedAt: number | null
  /** 运行时目录覆盖的 provider 数。 */
  catalogProviders: number
}

export interface SkillItem {
  /** 相对 skills/ 的目录路径（嵌套目录用 / 分隔）。 */
  relDir: string
  name: string
  description: string
  disableModelInvocation: boolean
  /** SKILL.md 相对 home 的路径。 */
  filePath: string
  revision: string
  bytes: number
}

export interface SkillsListing {
  skills: SkillItem[]
  /** 读取失败时的警告。 */
  warnings: string[]
}

export interface AgentProfileSummary {
  file: string
  name: string
  description: string
  extraKeys: string[]
  bodyPreview: string
  bytes: number
}

export interface AgentsSettingsView {
  path: string
  exists: boolean
  revision: string
  builtInEnabled: boolean
  disabledBuiltIns: string[]
  maxConcurrent: number | null
}

export interface AgentsListing {
  profiles: AgentProfileSummary[]
  settings: AgentsSettingsView
}

export interface AgentProfileDetail {
  file: string
  content: string
  revision: string
}

export interface McpServerView {
  name: string
  entry: Record<string, unknown>
  maskedFields: string[]
  varRefs: string[]
  commandValues: string[]
}

export interface McpListing {
  path: string
  exists: boolean
  revision: string
  servers: McpServerView[]
}

export interface ProviderView {
  name: string
  baseUrl: string
  apiKeyMasked: string | null
  hasApiKey: boolean
  modelCount: number
  entry: Record<string, unknown>
}

export interface ModelsListing {
  path: string
  exists: boolean
  revision: string
  providers: ProviderView[]
  hadComments: boolean
}

export type AuthEntryType = 'oauth' | 'api_key' | 'unknown'

export interface AuthEntryView {
  provider: string
  type: AuthEntryType
  /** 遮蔽后的条目 JSON：key / access / refresh 显示为掩码。 */
  entry: Record<string, unknown>
  /** 被遮蔽的字段名（key / access / refresh）。 */
  maskedFields: string[]
  /** oauth 过期时间（epoch ms）。 */
  expires: number | null
  /** api_key 的 key 是 `!command` 形式。 */
  keyCommand: string | null
}

export interface AuthListing {
  path: string
  exists: boolean
  revision: string
  entries: AuthEntryView[]
}

export interface PackageEntryView {
  index: number
  source: string
  kind: 'plain' | 'object'
  disabled: boolean
  hasFilters: boolean
  autoload: boolean
  installedDir: string | null
}

export interface PluginsListing {
  packages: PackageEntryView[]
  revision: string
}

export interface MutationResult {
  ok: true
  revision: string
  changed: boolean
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
