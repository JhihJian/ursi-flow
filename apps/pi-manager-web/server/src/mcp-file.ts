import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot } from './rw.ts'
import { isSecretName, maskArgs, maskSecret, maskStringField } from './mcp-mask.ts'

/**
 * mcp.json 的文件级管理。
 *
 * 与 pi-web 的 mcp-config-read 同一原则：纯文件读，不展开 ${VAR}、
 * 不执行 !command、不 spawn。字面量密钥在 env/headers/oauth.clientSecret 与
 * url/command/args 里都遮蔽后返回；`${VAR}` 引用与 !command 原样保留。
 *
 * 条目形状与 pi 的 McpServerConfig 对齐：command/args/env/cwd（stdio）、
 * url/headers（http）、type 标注传输方式、enabled、exposure。
 */

export type McpTransport = 'stdio' | 'http' | 'unknown'
export type McpExposure = 'direct' | 'deferred' | 'codemode'

export interface McpServerView {
  name: string
  /** 原样 JSON 条目，敏感值已替换为遮蔽标记。 */
  entry: Record<string, unknown>
  /** 条目里被遮蔽的字段路径列表，如 ["env.API_KEY", "args[1]"]。 */
  maskedFields: string[]
  /** 值里含 ${VAR} 引用的字段路径。 */
  varRefs: string[]
  /** 值是 !command 形式的字段路径（不执行，仅警示）。 */
  commandValues: string[]
  /** 含不可见/控制字符的字段路径（显示时需注意）。 */
  hiddenChars: string[]
  transport: McpTransport
  /** 未写 enabled 视为启用。 */
  enabled: boolean
  /** 未写 exposure 视为 codemode（pi 的默认）。 */
  exposure: McpExposure
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

export function mcpConfigPath(home: string): string {
  return join(home, 'mcp.json')
}

type McpData = Record<string, unknown>

const HIDDEN_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/

/** 递归处理一个条目值：返回遮蔽后的副本并收集标注。 */
function processValue(
  key: string,
  value: unknown,
  prefix: string,
  masked: string[],
  varRefs: string[],
  commandValues: string[],
  hiddenChars: string[],
): unknown {
  const path = prefix ? `${prefix}.${key}` : key
  if (typeof value === 'string') {
    if (HIDDEN_CHAR_RE.test(value)) hiddenChars.push(path)
    if (value.startsWith('!')) {
      commandValues.push(path)
      return value
    }
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value) || /\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/.test(value)) {
      varRefs.push(path)
    }
    const next = maskStringField(key, value)
    if (next !== value) masked.push(path)
    return next
  }
  if (Array.isArray(value)) {
    // args 作为一整个序列遮蔽：`--token <值>` 的关联跨项。
    const strings = key === 'args' && value.every((item) => typeof item === 'string')
      ? (value as string[])
      : null
    const maskedArgs = strings ? maskArgs(strings) : null
    return value.map((item, index) => {
      const itemPath = `${path}[${index}]`
      if (typeof item !== 'string') return item
      if (HIDDEN_CHAR_RE.test(item)) hiddenChars.push(itemPath)
      if (item.startsWith('!')) {
        commandValues.push(itemPath)
        return item
      }
      const next = maskedArgs ? maskedArgs[index] : item
      if (next !== item) masked.push(itemPath)
      return next
    })
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = processValue(k, v, path, masked, varRefs, commandValues, hiddenChars)
    }
    return out
  }
  return value
}

function stringRecordKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : []
}

function transportOf(entry: Record<string, unknown>): McpTransport {
  if (typeof entry.command === 'string') return 'stdio'
  if (typeof entry.url === 'string') return 'http'
  return 'unknown'
}

export function readMcp(home: string): McpListing {
  const path = mcpConfigPath(home)
  if (!existsSync(path)) {
    return { path, exists: false, revision: '', servers: [] }
  }
  const snap = readSnapshotSync<McpData>(path, (text) => {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('mcp.json 顶层必须是对象')
    }
    return parsed as McpData
  })
  // mcp.json 形状：{ mcpServers: { <name>: entry } }；兼容旧式顶层直写。
  const root = snap.data.mcpServers
  const entries: Record<string, unknown> =
    root && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : snap.data
  const servers: McpServerView[] = []
  for (const [name, raw] of Object.entries(entries)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const masked: string[] = []
    const varRefs: string[] = []
    const commandValues: string[] = []
    const hiddenChars: string[] = []
    const view: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(entry)) {
      view[k] = processValue(k, v, '', masked, varRefs, commandValues, hiddenChars)
    }
    const exposure = entry.exposure === 'direct' || entry.exposure === 'deferred' || entry.exposure === 'codemode'
      ? entry.exposure
      : 'codemode'
    servers.push({
      name,
      entry: view,
      maskedFields: masked,
      varRefs,
      commandValues,
      hiddenChars,
      transport: transportOf(entry),
      enabled: entry.enabled !== false,
      exposure,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      envNames: stringRecordKeys(entry.env),
      headerNames: stringRecordKeys(entry.headers),
    })
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))
  return { path, exists: true, revision: snap.revision, servers }
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new ConflictError(`server 名只能包含字母数字与 -_：${name}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读文件并定位 server 条目。
 * - 标准形状 `{ mcpServers: {...} }`：wrapped = true。
 * - 旧式顶层直写（顶层键就是 server）：wrapped = false，写回保持同样的形状。
 * - `mcpServers` 存在但不是对象：拒绝，不覆盖。
 */
function readRootEntries(path: string): {
  base: Record<string, unknown>
  entries: Record<string, unknown>
  wrapped: boolean
} {
  if (!existsSync(path)) return { base: {}, entries: {}, wrapped: true }
  const base = readSnapshotSync<Record<string, unknown>>(path, (text) => {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) throw new ConflictError('mcp.json 顶层必须是对象，请先修复文件')
    return parsed
  }).data
  const root = base.mcpServers
  if (root !== undefined) {
    if (!isRecord(root)) throw new ConflictError('mcp.json 的 mcpServers 必须是对象，请先修复文件')
    return { base, entries: root, wrapped: true }
  }
  if (Object.keys(base).length === 0) return { base, entries: {}, wrapped: true }
  return { base, entries: base, wrapped: false }
}

function assemble(base: Record<string, unknown>, entries: Record<string, unknown>, wrapped: boolean): Record<string, unknown> {
  return wrapped ? { ...base, mcpServers: entries } : entries
}

/** 用服务端保存的原文（未遮蔽）写回。payload 来自前端提交的完整条目。 */
export async function mergeMcp(
  home: string,
  expectedRevision: string,
  submitted: Record<string, Record<string, unknown> | null>,
): Promise<string> {
  const path = mcpConfigPath(home)
  const { base, entries: currentRoot, wrapped } = readRootEntries(path)
  const nextRoot: Record<string, unknown> = { ...currentRoot }
  for (const [name, entry] of Object.entries(submitted)) {
    assertServerName(name)
    if (entry === null) {
      delete nextRoot[name]
      continue
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConflictError(`server ${name} 的条目必须是对象`)
    }
    const original = currentRoot[name]
    const resolved = original && typeof original === 'object' && !Array.isArray(original)
      ? resolveMasked(entry, original as Record<string, unknown>)
      : rejectSubmittedMasked(name, entry)
    // 还原后仍有占位符（例如用户新加的 header 值写成掩码）：拒绝，不写占位符。
    if (maskedPathsOf(resolved).length > 0) {
      throw new ConflictError(`server ${name} 含无法还原的遮蔽占位符，请填写真实值`)
    }
    nextRoot[name] = resolved
  }
  const next = assemble(base, nextRoot, wrapped)
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify(next, null, 2)}\n`)
  return readMcp(home).revision
}

/** 只改 enabled / exposure，不触碰条目其它字段（对齐 pi 的开关语义）。 */
export async function patchMcpServer(
  home: string,
  expectedRevision: string,
  name: string,
  patch: { enabled?: boolean; exposure?: McpExposure },
): Promise<string> {
  assertServerName(name)
  const path = mcpConfigPath(home)
  const { base, entries, wrapped } = readRootEntries(path)
  const original = entries[name]
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new ConflictError(`mcp.json 里没有 server ${name}`)
  }
  const entry: Record<string, unknown> = { ...(original as Record<string, unknown>) }
  if (patch.enabled !== undefined) {
    // pi 的编辑器删除 enabled: true，只在停用时写 false。
    if (patch.enabled) delete entry.enabled
    else entry.enabled = false
  }
  if (patch.exposure !== undefined) {
    // codemode 是默认值，同样删键。
    if (patch.exposure === 'codemode') delete entry.exposure
    else entry.exposure = patch.exposure
  }
  const next = assemble(base, { ...entries, [name]: entry }, wrapped)
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify(next, null, 2)}\n`)
  return readMcp(home).revision
}

// ---------------------------------------------------------------------------
// 遮蔽占位还原：前端把读到的（遮蔽）条目原样提交时，写回前用文件里的
// 原文还原被遮蔽字段，避免把占位符写进磁盘。
//
// 判定不用 startsWith('•••')：URL/命令是局部遮蔽，只有「提交值等于原文的
// 遮蔽形式」才算未改动；用户改过的值按新值写入。
// ---------------------------------------------------------------------------

function resolveMasked(
  submitted: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(submitted)) {
    const orig = original[k]
    if (typeof v === 'string') {
      out[k] = restoreString(k, v, orig)
      continue
    }
    if (Array.isArray(v)) {
      const originalArgs = k === 'args' && Array.isArray(orig) && orig.every((item) => typeof item === 'string')
        ? (orig as string[])
        : null
      // 按遮蔽形式匹配而不是按下标：用户在前插/删除参数后仍能还原。
      const pool = originalArgs
        ? maskArgs(originalArgs).map((masked, index) => ({ masked, value: originalArgs[index], used: false }))
        : []
      out[k] = v.map((item) => {
        if (typeof item !== 'string') return item
        const hit = pool.find((candidate) => !candidate.used && candidate.masked === item)
        if (!hit) return item
        hit.used = true
        return hit.value
      })
      continue
    }
    if (v !== null && typeof v === 'object' && orig !== null && typeof orig === 'object' && !Array.isArray(orig)) {
      out[k] = resolveMasked(v as Record<string, unknown>, orig as Record<string, unknown>)
      continue
    }
    out[k] = v
  }
  return out
}

function restoreString(key: string, submitted: string, original: unknown): string {
  if (typeof original !== 'string') return submitted
  if (submitted === original) return submitted
  return maskStringField(key, original) === submitted ? original : submitted
}

function rejectSubmittedMasked(name: string, entry: Record<string, unknown>): Record<string, unknown> {
  if (maskedPathsOf(entry).length > 0) {
    throw new ConflictError(`server ${name} 含遮蔽占位符但文件里没有原值，请填写真实值`)
  }
  return entry
}

function maskedPathsOf(entry: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(entry)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      if (v.includes('•••')) out.push(path)
    } else if (Array.isArray(v)) {
      v.forEach((item, index) => {
        if (typeof item === 'string' && item.includes('•••')) out.push(`${path}[${index}]`)
        else if (item !== null && typeof item === 'object') {
          out.push(...maskedPathsOf(item as Record<string, unknown>, `${path}[${index}]`))
        }
      })
    } else if (v !== null && typeof v === 'object') {
      out.push(...maskedPathsOf(v as Record<string, unknown>, path))
    }
  }
  return out
}

export { isSecretName, maskSecret }
