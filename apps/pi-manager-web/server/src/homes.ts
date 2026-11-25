import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'

/**
 * 已知 pi home 的发现。
 *
 * 一个 pi home 是 pi coding agent 的完整配置目录（默认 ~/.pi/agent）。本机可能
 * 同时存在多个：默认位置、`PI_CODING_AGENT_DIR` 指定的位置、同一台机器上其他
 * 用户的 home，以及用户在前端登记的预设。这里只负责把文件系统上真实存在的
 * 候选目录收集起来并给出轻量摘要，不持有"当前 home"。
 */

export type HomeSource = 'default' | 'env' | 'user' | 'manual'

export interface HomeSummary {
  /** 绝对路径（去尾斜杠）。 */
  path: string
  /** 展示用短名：家目录内用 ~，其他用户的用 owner/.pi/agent。 */
  label: string
  /** 目录存在且含 settings.json。 */
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

const HOME_OWNER_ROOTS = ['/home', '/Users', '/root']

function countSkills(dir: string): number {
  let total = 0
  const walk = (abs: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(abs, { withFileTypes: false }) as string[]
    } catch {
      return
    }
    for (const name of entries) {
      const entry = { name, isDirectory: () => isDirectory(join(abs, name)) }
      if (!entry.isDirectory()) continue
      const next = join(abs, entry.name)
      if (existsSync(join(next, 'SKILL.md'))) total += 1
      else if (depth < 3) walk(next, depth + 1)
    }
  }
  walk(dir, 0)
  return total
}

function countAgents(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md')).length
  } catch {
    return 0
  }
}

function countMcpServers(path: string): number {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const root = (data.mcpServers ?? data) as Record<string, unknown>
    return Object.keys(root).length
  } catch {
    return 0
  }
}

function countPackages(path: string): number {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { packages?: unknown }
    return Array.isArray(data.packages) ? data.packages.length : 0
  } catch {
    return 0
  }
}

/** 短名：家目录内用 ~ 开头，其他用户的 home 用 owner 前缀。 */
export function displayLabel(path: string): string {
  const home = homedir()
  if (path === join(home, '.pi', 'agent')) return '~/.pi/agent'
  if (path.startsWith(home + '/')) return `~/${path.slice(home.length + 1)}`
  const parent = dirname(path)
  if (basename(parent) === '.pi') {
    const owner = basename(dirname(parent))
    if (owner) return `${owner}/.pi/agent`
  }
  return path
}

export function summariseHome(path: string, sources: HomeSource[]): HomeSummary {
  const label = displayLabel(path)
  const empty = {
    path,
    label,
    valid: false,
    sources,
    skills: 0,
    agents: 0,
    mcpServers: 0,
    packages: 0,
    hasModels: false,
    hasAuth: false,
  }
  try {
    if (!statSync(path).isDirectory()) return { ...empty, error: '不是目录' }
    readdirSync(path)
  } catch {
    return { ...empty, error: '目录不可访问' }
  }
  return {
    path,
    label,
    valid: existsSync(join(path, 'settings.json')),
    sources,
    skills: countSkills(join(path, 'skills')),
    agents: countAgents(join(path, 'agents')),
    mcpServers: countMcpServers(join(path, 'mcp.json')),
    packages: countPackages(join(path, 'settings.json')),
    hasModels: existsSync(join(path, 'models.json')),
    hasAuth: existsSync(join(path, 'auth.json')),
  }
}

/** pi 自己的首页候选：默认位置、环境变量位置、同机其他用户位置。 */
function candidatePaths(): string[] {
  const home = homedir()
  const out = [join(home, '.pi', 'agent')]
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim()
  if (fromEnv) out.push(fromEnv.startsWith('~') ? join(home, fromEnv.slice(1)) : fromEnv)
  for (const root of HOME_OWNER_ROOTS) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) out.push(join(root, entry.name, '.pi', 'agent'))
      }
    } catch {
      /* 目录不存在或不可读 */
    }
  }
  return out
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 已知 pi home 列表。默认位置与 env 位置排在最前，其余按路径排序。
 * `extra` 是前端登记的预设路径，允许指向尚不存在的位置（用于提示失效预设）。
 */
export function discoverHomes(extra: string[] = []): HomeSummary[] {
  const home = homedir()
  const defaultPath = join(home, '.pi', 'agent')
  const envRaw = process.env.PI_CODING_AGENT_DIR?.trim()
  const envPath = envRaw
    ? envRaw.startsWith('~')
      ? join(home, envRaw.slice(1))
      : envRaw
    : null

  const byPath = new Map<string, HomeSummary>()
  const add = (raw: string, forcedSource?: HomeSource): void => {
    // 前端登记的预设可能是 ~ 开头，先展开成家目录再比较，避免与默认项重复。
    const expanded = raw.trim().startsWith('~')
      ? join(home, raw.trim().slice(1))
      : raw.trim()
    const path = expanded.replace(/\/+$/, '') || '/'
    const existing = byPath.get(path)
    if (existing) {
      // 默认/env 位置本身就是已知项，再登记成预设没有意义。
      const primary = existing.sources.includes('default') || existing.sources.includes('env')
      if (forcedSource && !primary && !existing.sources.includes(forcedSource)) {
        existing.sources.push(forcedSource)
      }
      return
    }
    const exists = isDirectory(path)
    if (!exists && forcedSource !== 'manual') return
    const sources: HomeSource[] = []
    if (path === defaultPath) sources.push('default')
    else if (envPath && path === envPath) sources.push('env')
    else if (forcedSource === 'manual') sources.push('manual')
    else sources.push('user')
    byPath.set(path, summariseHome(path, sources))
  }

  add(defaultPath)
  if (envPath) add(envPath)
  for (const p of candidatePaths()) add(p)
  for (const p of extra) add(p, 'manual')

  const rank = (h: HomeSummary): number =>
    h.sources.includes('default') ? 0 : h.sources.includes('env') ? 1 : 2
  return [...byPath.values()].sort((a, b) => {
    const diff = rank(a) - rank(b)
    return diff !== 0 ? diff : a.path.localeCompare(b.path)
  })
}
