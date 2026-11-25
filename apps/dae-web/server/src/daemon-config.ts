import type { DaeClient } from './proxy.ts'

/**
 * 配置页的服务端能力。
 *
 * 写配置完全交给 dae 自己的接口（api.config_write + api.secret）：
 * dae 负责校验、写文件（生成 .bak）与热加载，本服务只做三件事：
 * 注入 token、把源路径解析成 source id、把 202 操作轮询到终态。
 */

export interface ConfigSourceView {
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
  sources: ConfigSourceView[]
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

interface ConfigReadback {
  generation_id: string
  revision: string
  sources: ConfigSourceView[]
  secrets_redacted: boolean
}

interface CapabilitiesView {
  resources: {
    config: {
      writable: boolean
      'x-dae'?: { layout?: { kind?: string; reason?: string } }
    }
  }
}

interface AcceptedOperation {
  operation_id: string
}

interface OperationView {
  operation_id: string
  kind: string
  status: string
  result: { active_generation_id?: string } | null
  error: { message?: string } | null
}

const OPERATION_TIMEOUT_MS = 20_000
const OPERATION_POLL_MS = 250

export class ConfigError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ConfigError'
    this.status = status
  }
}

export function createConfigService(dae: DaeClient, mainConfigPath: string) {
  async function readSnapshot(): Promise<ConfigSnapshot> {
    const [config, capabilities] = await Promise.all([
      dae.call<ConfigReadback>('/api/v1/config'),
      dae.call<CapabilitiesView>('/api/v1/capabilities'),
    ])
    const capability = capabilities.resources.config
    return {
      ...config,
      writable: capability.writable,
      layout: capability['x-dae']?.layout?.kind ?? 'unknown',
      layout_reason: capability['x-dae']?.layout?.reason ?? '',
      file: mainConfigPath,
    }
  }

  async function sourceByPath(sourcePath: string): Promise<ConfigSourceView> {
    const snapshot = await readSnapshot()
    const source = snapshot.sources.find((item) => item.path === sourcePath)
    if (!source) throw new ConfigError(`没有名为 ${sourcePath} 的配置源`, 404)
    if (!source.writable) {
      throw new ConfigError(
        `${sourcePath} 不可写（${source.read_only_reason ?? '未知原因'}）`,
        403,
      )
    }
    return source
  }

  async function waitOperation(operationId: string): Promise<string | null> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const operation = await dae.call<OperationView>(
        `/api/v1/operations/${encodeURIComponent(operationId)}`,
      )
      if (operation.status === 'succeeded') {
        return operation.result?.active_generation_id ?? null
      }
      if (operation.status === 'failed') {
        throw new ConfigError(operation.error?.message ?? 'dae 应用配置失败', 500)
      }
      await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS))
    }
    throw new ConfigError('等待 dae 应用配置超时（20s）', 504)
  }

  /** 只读文件本身不可写，写权限由 dae 的 managed layout 决定。 */
  async function check(sourcePath: string, content: string): Promise<ConfigCheckResult> {
    const result = await dae.call<ConfigCheckResult>('/api/v1/config/validate', {
      method: 'POST',
      body: { mode: 'full', sources: [{ path: sourcePath, content }] },
      timeoutMs: 60_000,
    })
    return result
  }

  async function apply(sourcePath: string, content: string, expectedSha: string): Promise<ConfigApplyResult> {
    // If-Match 用 dae 上报的 content_sha256，避免覆盖别处已改的内容。
    const source = await sourceByPath(sourcePath)
    if (source.content_sha256 !== expectedSha) {
      throw new ConfigError('配置已在别处变更，请重新加载后再改', 409)
    }
    const validation = await check(sourcePath, content)
    if (!validation.valid) {
      throw new ConfigError(
        `配置校验未通过：${validation.diagnostics[0]?.message ?? '未知原因'}`,
        422,
      )
    }
    const accepted = await dae.call<AcceptedOperation>(
      `/api/v1/config/sources/${encodeURIComponent(source.id)}`,
      {
        method: 'PUT',
        body: { content },
        headers: {
          'If-Match': `"${source.content_sha256}"`,
          'Idempotency-Key': `dae-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      },
    )
    const generationId = await waitOperation(accepted.operation_id)
    return { ok: true, operationId: accepted.operation_id, generationId, sourcePath }
  }

  return { readSnapshot, check, apply }
}

export type ConfigService = ReturnType<typeof createConfigService>
