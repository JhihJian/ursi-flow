import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ConflictError, readSnapshotSync, writeSnapshot } from './rw.ts'

/**
 * mcp.json 的文件级管理。
 *
 * 与 pi-web 的 mcp-config-read 同一原则：纯文件读，不展开 ${VAR}、
 * 不执行 !command、不 spawn。env/headers 里疑似字面量密钥的值一律遮蔽后返回。
 * 条目形状与 pi 的 McpServerConfig 对齐：command/args/env（stdio）、
 * url/headers（http）、type 标注传输方式；允许 ${VAR} 引用。
 */

export interface McpServerView {
  name: string
  /** 原样 JSON 条目，敏感值已替换为遮蔽标记。 */
  entry: Record<string, unknown>
  /** 条目里被遮蔽的字段路径列表，如 ["env.API_KEY"]。 */
  maskedFields: string[]
  /** 值里含 ${VAR} 引用的字段路径。 */
  varRefs: string[]
  /** 值是 !command 形式的字段路径（不执行，仅警示）。 */
  commandValues: string[]
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

/*
 * 敏感字段判定对齐 pi-web 的 mcp-secrets.ts：
 * - 名字含凭据词（key/token/secret/password/authorization/bearer 等，含连字符与
 *   驼峰切分，排除 *_FILE、*_URL 等限定名结尾）；
 * - 或值是 `Bearer <token>` 这类字面量凭据短语。
 * 含 ${VAR} 引用的值是引用不是密钥，不遮蔽。
 */
const SECRET_WORDS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'passphrase', 'pwd',
  'pass', 'credential', 'credentials', 'authorization', 'bearer', 'jwt',
  'cookie', 'signature', 'pat',
])
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey']
const QUALIFIER_WORDS = new Set([
  'file', 'path', 'dir', 'url', 'uri', 'endpoint', 'id', 'name', 'type',
  'header', 'env', 'var', 'cmd', 'command', 'script', 'prompt', 'range',
])
const CREDENTIAL_PHRASE_RE = /^(?:bearer|basic|token)\s+\S/i
const VAR_REF_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/
const ANY_VAR_REF = new RegExp(VAR_REF_RE.source)

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSecretName(name: string): boolean {
  const parts = nameWords(name)
  if (parts.length > 1 && QUALIFIER_WORDS.has(parts[parts.length - 1])) return false
  return parts.some(
    (word) => SECRET_WORDS.has(word) || SECRET_SUFFIXES.some((s) => word.length > s.length && word.endsWith(s)),
  )
}

function hasVarRef(value: string): boolean {
  return ANY_VAR_REF.test(value)
}

/** 是否是值得遮蔽的字面量敏感值（名字像密钥，或值是 Bearer <token> 这类短语）。 */
function isLiteralSecret(key: string, value: string): boolean {
  if (value === '' || value.startsWith('!') || hasVarRef(value)) return false
  return isSecretName(key) || CREDENTIAL_PHRASE_RE.test(value)
}

/** 递归处理一个条目值：返回遮蔽后的副本并收集标注。 */
function processValue(
  key: string,
  value: unknown,
  prefix: string,
  masked: string[],
  varRefs: string[],
  commandValues: string[],
): unknown {
  const path = prefix ? `${prefix}.${key}` : key
  if (typeof value === 'string') {
    if (value.startsWith('!')) {
      commandValues.push(path)
      return value
    }
    if (hasVarRef(value)) {
      varRefs.push(path)
      return value
    }
    if (isLiteralSecret(key, value)) {
      masked.push(path)
      return maskSecret(value)
    }
    return value
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = processValue(k, v, path, masked, varRefs, commandValues)
    }
    return out
  }
  return value
}

export function maskSecret(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : ''
  return `•••${tail ? `（末4位 ${tail}）` : ''}`
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
    const masked: string[] = []
    const varRefs: string[] = []
    const commandValues: string[] = []
    const entry: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      entry[k] = processValue(k, v, '', masked, varRefs, commandValues)
    }
    servers.push({ name, entry, maskedFields: masked, varRefs, commandValues })
  }
  servers.sort((a, b) => a.name.localeCompare(b.name))
  return { path, exists: true, revision: snap.revision, servers }
}

/** 用服务端保存的原文（未遮蔽）写回。payload 来自前端提交的完整条目。 */
export async function writeMcp(
  home: string,
  expectedRevision: string,
  servers: Record<string, unknown>,
): Promise<string> {
  const path = mcpConfigPath(home)
  for (const [name, entry] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      throw new ConflictError(`server 名只能包含字母数字与 -_：${name}`)
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConflictError(`server ${name} 的条目必须是对象`)
    }
  }
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  const fresh = readMcp(home)
  return fresh.revision
}

// ---------------------------------------------------------------------------
// 遮蔽占位还原：前端把读到的（遮蔽）条目原样提交时，写回前用文件里的
// 原文还原被遮蔽字段，避免把占位符写进磁盘。
// ---------------------------------------------------------------------------

/** 深比较两值是否相等（对象/数组按内容）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** 提交条目里被遮蔽的字段路径（值等于占位串）。 */
function maskedPathsOf(entry: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(entry)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string' && v.startsWith('•••')) out.push(path)
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...maskedPathsOf(v as Record<string, unknown>, path))
    }
  }
  return out
}

function resolveMasked(
  submitted: Record<string, unknown>,
  original: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(submitted)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string' && v.startsWith('•••')) {
      const orig = original[k]
      // 提交值与原文的掩码一致才还原；用户改过则以提交为准（视为新字面量）。
      out[k] = typeof orig === 'string' && maskSecret(orig) === v ? orig : v
      continue
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const orig = original[k]
      out[k] =
        orig !== null && typeof orig === 'object' && !Array.isArray(orig)
          ? resolveMasked(v as Record<string, unknown>, orig as Record<string, unknown>, path)
          : v
      continue
    }
    out[k] = v
  }
  return out
}

/** mcp.json 合并写回：entries 为 null 的键删除，其余条目还原遮蔽后覆盖。 */
export async function mergeMcp(
  home: string,
  expectedRevision: string,
  entries: Record<string, Record<string, unknown> | null>,
): Promise<string> {
  const path = mcpConfigPath(home)
  let base: Record<string, unknown> = {}
  try {
    base = readSnapshotSync<Record<string, unknown>>(path, JSON.parse).data
  } catch {
    base = {}
  }
  const root = base.mcpServers
  const currentRoot: Record<string, unknown> =
    root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>) : {}
  // 原文（未遮蔽）条目，用于把提交里的掩码占位符还原。
  const originals = new Map(Object.entries(currentRoot))
  const nextRoot: Record<string, unknown> = { ...currentRoot }
  const next = { ...base, mcpServers: nextRoot }
  for (const [name, entry] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      throw new ConflictError(`server 名只能包含字母数字与 -_：${name}`)
    }
    if (entry === null) {
      delete nextRoot[name]
      continue
    }
    const original = originals.get(name)
    nextRoot[name] = original
      ? resolveMasked(entry, original as Record<string, unknown>)
      : rejectSubmittedMasked(name, entry)
  }
  await writeSnapshot(path, expectedRevision, () => `${JSON.stringify(next, null, 2)}\n`)
  return readMcp(home).revision
}

function rejectSubmittedMasked(name: string, entry: Record<string, unknown>): Record<string, unknown> {
  if (maskedPathsOf(entry).length > 0) {
    throw new ConflictError(`server ${name} 含遮蔽占位符但文件里没有原值，请填写真实值`)
  }
  return entry
}

