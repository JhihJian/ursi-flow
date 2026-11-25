/** 本服务控制面（/console/*）：dae 配置源列表、按源校验与保存。 */

export interface ConfigSource {
  id: string
  path: string
  kind: string
  content_sha256: string
  bytes: number
  content: string
  line_count: number
  writable: boolean
  read_only_reason?: string
  loaded_at: string
}

export interface ConfigSnapshot {
  generation_id: string
  revision: string
  sources: ConfigSource[]
  secrets_redacted: boolean
  writable: boolean
  layout: string
  layout_reason: string
  file: string
}

export interface ConfigDiagnostic {
  level: string
  source_id: string
  line: number | null
  column: number | null
  code: string
  message: string
}

export interface ConfigCheckResult {
  valid: boolean
  diagnostics: ConfigDiagnostic[]
  validated_at: string
}

export interface ConfigApplyResult {
  ok: boolean
  operationId: string
  generationId: string | null
  sourcePath: string
}

export class ConsoleError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ConsoleError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/console${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ?? `请求失败 ${response.status}`
    throw new ConsoleError(message, response.status)
  }
  return parsed as T
}

export function getConfig(): Promise<ConfigSnapshot> {
  return request('/config')
}

export function checkConfig(sourcePath: string, content: string): Promise<ConfigCheckResult> {
  return request('/config/check', {
    method: 'POST',
    body: JSON.stringify({ sourcePath, content }),
  })
}

export function applyConfig(
  sourcePath: string,
  content: string,
  expectedSha256: string,
): Promise<ConfigApplyResult> {
  return request('/config/apply', {
    method: 'POST',
    body: JSON.stringify({ sourcePath, content, expectedSha256 }),
  })
}
