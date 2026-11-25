import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callDae } from './proxy.ts'

/**
 * dae 配置文件的读写与生效。
 *
 * dae 自己写文件需要 api.config_write + api.secret（设了 secret 后匿名回环失效，
 * 全部 API 都要 Bearer token）。本服务不改 dae 的认证模型，改为：
 * dae 负责校验（POST /config/validate mode=full）与热加载（POST /operations/reload），
 * 文件由本机 sudo 写入，写前备份、reload 失败自动回滚。
 */

export interface ConfigSourceView {
  id: string
  path: string
  kind: string
  content_sha256: string
  bytes: number
  content: string
  writable: boolean
  read_only_reason?: string
}

interface EffectiveConfig {
  generation_id: string
  revision: string
  sources: ConfigSourceView[]
  diagnostics: unknown[]
  secrets_redacted: boolean
}

interface ValidateResult {
  valid: boolean
  diagnostics: Array<{
    level: string
    source_id: string
    line: number | null
    column: number | null
    code: string
    message: string
  }>
  validated_at: string
}

interface OperationView {
  operation_id: string
  kind: string
  status: string
  error: { code?: string; message?: string } | null
  result: unknown
}

export interface ConfigSnapshot {
  /** 写入的本机文件路径。 */
  file: string
  /** dae 侧的 source 标识，校验请求要用它。 */
  sourcePath: string | null
  content: string
  sha256: string | null
  /** dae 是否自己就能写（api.config_write）。 */
  apiWritable: boolean
  apiReason: string | null
  /** 密钥被脱敏时禁止保存，否则会把掩码写回文件。 */
  secretsRedacted: boolean
  /** 本服务能否以 sudo 写该文件。 */
  canWrite: boolean
  writeReason: string | null
  backups: BackupEntry[]
}

export interface BackupEntry {
  name: string
  bytes: number
  created_at: string
}

export interface ApplyResult {
  operationId: string | null
  backup: string
  generationId: string | null
  rolledBack: boolean
}

export interface ConfigStoreOptions {
  apiBase: string
  filePath: string
  backupDir: string
}

const MAX_BACKUPS = 20

async function runSudo(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => reject(new Error(`执行 sudo 失败：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`sudo ${args.join(' ')} 失败（${code}）：${stderr.trim() || '无输出'}`))
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function createConfigStore(options: ConfigStoreOptions) {
  const { apiBase, filePath, backupDir } = options

  async function readSource(): Promise<{ config: EffectiveConfig; source: ConfigSourceView | null }> {
    const config = await callDae<EffectiveConfig>(apiBase, '/api/v1/config')
    const source = config.sources.find((item) => item.kind === 'main') ?? config.sources[0] ?? null
    return { config, source }
  }

  async function listBackups(): Promise<BackupEntry[]> {
    try {
      const names = await fs.readdir(backupDir)
      const entries: BackupEntry[] = []
      for (const name of names.filter((item) => item.endsWith('.dae'))) {
        const info = await fs.stat(path.join(backupDir, name))
        entries.push({ name, bytes: info.size, created_at: info.mtime.toISOString() })
      }
      return entries.sort((left, right) => right.name.localeCompare(left.name))
    } catch {
      return []
    }
  }

  async function saveBackup(content: string): Promise<string> {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `config-${stamp}.dae`
    const target = path.join(backupDir, name)
    await fs.writeFile(target, content, { mode: 0o600 })
    const existing = await listBackups()
    for (const stale of existing.slice(MAX_BACKUPS)) {
      await fs.rm(path.join(backupDir, stale.name), { force: true })
    }
    return name
  }

  /** 文件属主是 root，读取也走 sudo。 */
  async function readFile(): Promise<string> {
    return runSudo(['cat', filePath])
  }

  async function writeFile(content: string): Promise<void> {
    // tee 覆盖已有文件时保留原属主与权限（root:root 0640）。
    await runSudo(['tee', filePath], content)
  }

  async function validate(content: string, sourcePath: string): Promise<ValidateResult> {
    return callDae<ValidateResult>(apiBase, '/api/v1/config/validate', {
      method: 'POST',
      body: { mode: 'full', sources: [{ path: sourcePath, content }] },
      timeoutMs: 60_000,
    })
  }

  async function reload(): Promise<{ operationId: string; generationId: string | null }> {
    const accepted = await callDae<{ operation_id: string }>(apiBase, '/api/v1/operations/reload', {
      method: 'POST',
      body: {},
    })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const operation = await callDae<OperationView>(
        apiBase,
        `/api/v1/operations/${encodeURIComponent(accepted.operation_id)}`,
      )
      if (operation.status === 'succeeded') {
        const generation =
          (operation.result as { active_generation_id?: string } | null)?.active_generation_id ?? null
        return { operationId: accepted.operation_id, generationId: generation }
      }
      if (operation.status === 'failed') {
        throw new Error(operation.error?.message ?? 'dae reload 失败')
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('等待 dae reload 超时（20s）')
  }

  async function snapshot(): Promise<ConfigSnapshot> {
    const { config, source } = await readSource()
    const [fileContent, backups] = await Promise.all([readFile(), listBackups()])
    let canWrite = true
    let writeReason: string | null = null
    if (config.secrets_redacted) {
      canWrite = false
      writeReason = 'dae 返回的配置含脱敏密钥，保存会把掩码写回文件'
    }
    return {
      file: filePath,
      sourcePath: source?.path ?? null,
      content: fileContent,
      sha256: source?.content_sha256 ?? null,
      apiWritable: source?.writable ?? false,
      apiReason: source?.read_only_reason ?? null,
      secretsRedacted: config.secrets_redacted,
      canWrite,
      writeReason,
      backups,
    }
  }

  async function check(content: string): Promise<ValidateResult> {
    const { source } = await readSource()
    if (!source) throw new Error('dae 未返回可校验的配置源')
    return validate(content, source.path)
  }

  async function apply(content: string, expectedSha: string | null): Promise<ApplyResult> {
    const { source } = await readSource()
    if (!source) throw new Error('dae 未返回可校验的配置源')
    if (expectedSha && source.content_sha256 !== expectedSha) {
      throw new Error('配置已在别处变更，请重新加载后再改')
    }
    const result = await validate(content, source.path)
    if (!result.valid) {
      throw new Error(`配置校验未通过：${result.diagnostics[0]?.message ?? '未知原因'}`)
    }

    const previous = await readFile()
    const backup = await saveBackup(previous)
    await writeFile(content)
    try {
      const reloaded = await reload()
      return {
        operationId: reloaded.operationId,
        backup,
        generationId: reloaded.generationId,
        rolledBack: false,
      }
    } catch (error) {
      // reload 失败不能把 dae 留在坏配置上：恢复备份并再次热加载。
      await writeFile(previous)
      let recoverNote = ''
      try {
        await reload()
      } catch (recoverError) {
        recoverNote = `；回滚后热加载仍失败：${
          recoverError instanceof Error ? recoverError.message : String(recoverError)
        }`
      }
      throw new Error(
        `热加载失败，已回滚到 ${backup}：${error instanceof Error ? error.message : String(error)}${recoverNote}`,
      )
    }
  }

  async function restore(name: string): Promise<ApplyResult> {
    // 只禁路径分隔符，备份名允许时间戳与中文注释。
    if (!name || name.includes('/') || name.includes('\\') || !name.endsWith('.dae')) {
      throw new Error('备份名称非法')
    }
    const content = await fs.readFile(path.join(backupDir, name), 'utf8')
    const { source } = await readSource()
    if (source) {
      const result = await validate(content, source.path)
      if (!result.valid) throw new Error(`备份内容校验未通过：${result.diagnostics[0]?.message ?? ''}`)
    }
    const current = await readFile()
    await saveBackup(current)
    await writeFile(content)
    const reloaded = await reload()
    return {
      operationId: reloaded.operationId,
      backup: name,
      generationId: reloaded.generationId,
      rolledBack: false,
    }
  }

  return { snapshot, check, apply, restore }
}

export type ConfigStore = ReturnType<typeof createConfigStore>

export function defaultBackupDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(base, 'dae-web', 'backups')
}
