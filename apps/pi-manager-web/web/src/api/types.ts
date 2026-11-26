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
  /** defaultTools 实际启用的内置工具（设置页开关的初始状态）。 */
  builtinTools: string[]
  builtinToolNames: string[]
  /** defaultTools 解析后的实际工具集。 */
  resolvedTools: string[]
  isWindows: boolean
  powerShellEnabled: boolean
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
  /** models.json 的 modelOverrides 原文（无覆盖为 null）。 */
  override: Record<string, unknown> | null
  /** 已被覆盖的字段名。 */
  overriddenFields: string[]
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
  /** models.json 的 revision，写 modelOverrides 时用作乐观锁。 */
  modelsRevision: string
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

export interface SkillFrontmatterEntry {
  key: string
  value: string
}

export interface SkillContent {
  relDir: string
  filePath: string
  raw: string
  frontmatter: SkillFrontmatterEntry[]
  body: string
  bytes: number
  revision: string
}

export interface AgentProfileFields {
  displayName: string | null
  model: string | null
  thinking: string | null
  /** null 表示文件未写 tools（跟随 pi 默认）。 */
  tools: string[] | null
  loadSkills: boolean
  loadExtensions: boolean
  codemode: 'off' | 'inherit' | 'on'
  mcp: 'off' | 'on'
  enabled: boolean
  inheritContext: boolean
  runInBackground: boolean
  promptMode: 'append' | 'replace'
  maxTurns: number | null
  color: string | null
  isolation: 'worktree' | 'off' | null
  persistSession: boolean | null
  /** 只读展示：文件里 skills: / extensions: 的白名单。 */
  skillsAlias: string[] | null
  extensionsAlias: string[] | null
}

export interface AgentProfile {
  file: string
  name: string
  description: string
  fields: AgentProfileFields
  /** frontmatter 里实际出现的受管 key。 */
  presentKeys: string[]
  /** 未受管 key 的原样文本行。 */
  extraKeys: string[]
  /** 值不是标准写法、保存时原样保留的受管 key。 */
  unparsedKeys: string[]
  body: string
  revision: string
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
  profiles: AgentProfile[]
  settings: AgentsSettingsView
}

export interface McpServerView {
  name: string
  entry: Record<string, unknown>
  maskedFields: string[]
  varRefs: string[]
  commandValues: string[]
  /** 含不可见/控制字符的字段路径。 */
  hiddenChars: string[]
  transport: 'stdio' | 'http' | 'unknown'
  enabled: boolean
  exposure: 'direct' | 'deferred' | 'codemode'
  cwd: string | null
  envNames: string[]
  headerNames: string[]
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

export interface ProbeResult {
  ok: boolean
  error?: string
  latencyMs?: number
  status?: number
  responseText?: string
}

export interface DiscoveredModel {
  id: string
  name?: string
  reasoning?: true
  thinkingLevelMap?: Record<string, string | null>
  input?: string[]
  contextWindow?: number
  maxTokens?: number
}

export interface DiscoveryResult {
  models: DiscoveredModel[]
  endpoint: string
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

/** 心跳文件里的一个活会话。 */
export interface LiveSession {
  sessionId: string
  sessionFile: string | null
  /** subagent 子会话指向父会话文件。 */
  parentSessionFile: string | null
  cwd: string
  name: string | null
  mode: string
  model: string | null
  status: 'running' | 'idle'
  startedAt: number
  updatedAt: number
  host: string
  pid: number
  /** 心跳来自本机时为 true。 */
  sameHost: boolean
}

export interface LiveSessionsListing {
  sessions: LiveSession[]
  heartbeatDir: string
  /** extensions/ 下是否检测到心跳扩展。 */
  pluginDetected: boolean
  /** 已超时或进程已退出的心跳数。 */
  stale: number
  now: number
  warnings: string[]
}

export interface MutationResult {
  ok: true
  revision: string
  changed: boolean
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
