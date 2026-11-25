/** 本服务控制面（/console/*）：dae 配置文件的读取、校验、保存与回滚。 */

export interface ConfigBackup {
  name: string
  bytes: number
  created_at: string
}

export interface ConfigSnapshot {
  file: string
  sourcePath: string | null
  content: string
  sha256: string | null
  apiWritable: boolean
  apiReason: string | null
  secretsRedacted: boolean
  canWrite: boolean
  writeReason: string | null
  backups: ConfigBackup[]
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
  operationId: string | null
  backup: string
  generationId: string | null
  rolledBack: boolean
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

export function checkConfig(content: string): Promise<ConfigCheckResult> {
  return request('/config/check', { method: 'POST', body: JSON.stringify({ content }) })
}

export function applyConfig(content: string, expectedSha256: string | null): Promise<ConfigApplyResult> {
  return request('/config/apply', {
    method: 'POST',
    body: JSON.stringify({ content, expectedSha256 }),
  })
}

export function restoreConfig(backup: string): Promise<ConfigApplyResult> {
  return request('/config/restore', { method: 'POST', body: JSON.stringify({ backup }) })
}
