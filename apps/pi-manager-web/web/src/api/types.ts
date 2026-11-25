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

export interface GeneralListing {
  revision: string
  path: string
  managed: Record<string, unknown>
  keyCount: number
  unmanagedKeys: string[]
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

export interface AuthEntryView {
  provider: string
  type: 'oauth' | 'api_key'
  masked: string | null
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
