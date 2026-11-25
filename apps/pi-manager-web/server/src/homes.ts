import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { HomeError, looksLikePiHome, resolveRequestedHome } from './pi-home.ts'

/**
 * pi home 清单：注册表 + 自动发现 + 创建与复制。
 *
 * 参照 `apps/fs-web` 的 workspace 清单模型：服务端持有清单并原子落盘，状态文件
 * 是唯一事实源；id 取 realpath 的 sha256 前 16 位（跨重启稳定）；条目可改名、
 * 编辑说明、从清单移除（不动文件系统）。此外 pi home 还能在清单里被创建：
 * 初始化出一份默认配置，或从另一份 home 复制配置。
 *
 * 自动发现（默认位置、PI_CODING_AGENT_DIR、同机其他用户）只用于播种与提示，
 * 清单里出现的条目才带用户自定义的 name / description。
 */

export type HomeSource = 'default' | 'env' | 'user' | 'manual'

export interface HomeEntry {
  id: string
  name: string
  path: string
  description?: string
}

export interface HomeSummary {
  id: string
  /** 用户定义的显示名；未在清单里的自动发现项取路径短名。 */
  name: string
  description?: string
  /** 绝对路径（去尾斜杠）。 */
  path: string
  /** 是否在服务端清单里（清单条目可改名、移除）。 */
  listed: boolean
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

/** 状态文件：XDG_STATE_HOME 优先，可用 PI_MANAGER_STATE 覆盖。 */
export function defaultStateFile(): string {
  const override = process.env.PI_MANAGER_STATE?.trim()
  if (override) return override
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'pi-manager-web', 'homes.json')
}

/** 跨重启稳定的 id：realpath 的 sha256 前 16 个 hex 字符。 */
export function homeIdOf(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

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
      const next = join(abs, name)
      if (!isDirectory(next)) continue
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

function summarise(path: string, base: { id: string; name: string; description?: string; listed: boolean; sources: HomeSource[] }): HomeSummary {
  const empty = {
    ...base,
    path,
    valid: false,
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
    ...base,
    path,
    valid: existsSync(join(path, 'settings.json')),
    skills: countSkills(join(path, 'skills')),
    agents: countAgents(join(path, 'agents')),
    mcpServers: countMcpServers(join(path, 'mcp.json')),
    packages: countPackages(join(path, 'settings.json')),
    hasModels: existsSync(join(path, 'models.json')),
    hasAuth: existsSync(join(path, 'auth.json')),
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** pi 的默认位置、env 位置与同机其他用户位置。 */
function discoveredPaths(): Array<{ path: string; source: HomeSource }> {
  const home = homedir()
  const out: Array<{ path: string; source: HomeSource }> = [{ path: join(home, '.pi', 'agent'), source: 'default' }]
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim()
  if (fromEnv) {
    out.push({ path: fromEnv.startsWith('~') ? join(home, fromEnv.slice(1)) : fromEnv, source: 'env' })
  }
  for (const root of HOME_OWNER_ROOTS) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) out.push({ path: join(root, entry.name, '.pi', 'agent'), source: 'user' })
      }
    } catch {
      /* 目录不存在或不可读 */
    }
  }
  return out
}

function normalisePath(raw: string): string {
  const home = homedir()
  const trimmed = raw.trim()
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(1)) : trimmed
  return expanded.replace(/\/+$/, '') || '/'
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

export class HomeRegistry {
  private readonly stateFile: string | null
  private readonly entries = new Map<string, HomeEntry>()
  private persistChain: Promise<void> = Promise.resolve()

  constructor(stateFile: string | null = defaultStateFile()) {
    this.stateFile = stateFile
    this.load()
  }

  /** 从状态文件加载；文件缺失时用自动发现播种。损坏或条目非法直接抛错。 */
  private load(): void {
    if (!this.stateFile) return
    let raw: string
    try {
      raw = readFileSync(this.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seedFromDiscovery()
        return
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(
        `pi home 状态文件不是合法 JSON：${this.stateFile}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
    if (!Array.isArray(parsed)) throw new Error(`pi home 状态文件应为数组：${this.stateFile}`)
    const seen = new Set<string>()
    for (const item of parsed) {
      const entry = parseEntry(item, this.stateFile)
      if (seen.has(entry.id)) throw new Error(`pi home 状态文件 id 重复：${entry.id}`)
      seen.add(entry.id)
      this.entries.set(entry.id, entry)
    }
  }

  /** 首次启动：把自动发现的有效 home 固化成清单。 */
  private seedFromDiscovery(): void {
    for (const { path, source } of discoveredPaths()) {
      if (source === 'user' || !isDirectory(path)) continue
      const id = homeIdOf(path)
      if (this.entries.has(id)) continue
      this.entries.set(id, { id, name: displayLabel(path), path })
    }
    void this.persist()
  }

  private persist(): Promise<void> {
    const stateFile = this.stateFile
    if (!stateFile) return Promise.resolve()
    const snapshot = [...this.entries.values()]
    const write = this.persistChain.then(() => {
      mkdirSync(dirname(stateFile), { recursive: true })
      const temp = join(dirname(stateFile), `.${basename(stateFile)}.tmp-${process.pid}`)
      writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, stateFile)
    })
    this.persistChain = write.catch(() => {})
    return write
  }

  /** 清单 + 自动发现合并后的完整列表：清单条目在前，未登记的发现项在后。 */
  list(): HomeSummary[] {
    const out: HomeSummary[] = []
    const seen = new Set<string>()
    for (const entry of this.entries.values()) {
      seen.add(entry.path)
      const sources: HomeSource[] = []
      if (entry.path === join(homedir(), '.pi', 'agent')) sources.push('default')
      else {
        const env = process.env.PI_CODING_AGENT_DIR?.trim()
        if (env && normalisePath(env) === entry.path) sources.push('env')
        else sources.push('manual')
      }
      out.push(
        summarise(entry.path, {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          listed: true,
          sources,
        }),
      )
    }
    for (const { path, source } of discoveredPaths()) {
      if (seen.has(path) || !isDirectory(path)) continue
      seen.add(path)
      out.push(
        summarise(path, {
          id: homeIdOf(path),
          name: displayLabel(path),
          listed: false,
          sources: [source],
        }),
      )
    }
    const rank = (h: HomeSummary): number =>
      h.sources.includes('default') ? 0 : h.sources.includes('env') ? 1 : h.listed ? 2 : 3
    return out.sort((a, b) => {
      const diff = rank(a) - rank(b)
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })
  }

  get(id: string): HomeEntry | null {
    return this.entries.get(id) ?? null
  }

  /**
   * 新增 pi home。
   * - adopt：目录必须已是 pi home
   * - init：目录不存在或为空 → 建目录 + 默认配置骨架
   * - clone：目录不存在或为空 → 从 from 复制配置（凭据默认不复制）
   */
  async add(input: {
    mode: 'adopt' | 'init' | 'clone'
    path: string
    name?: string
    from?: string
    includeAuth?: boolean
  }): Promise<HomeSummary> {
    const raw = input.path
    if (!raw || !raw.trim()) throw new HomeError('路径不能为空', 400, 'invalid_request')
    const target = normalisePath(raw)
    if (!target.startsWith('/')) throw new HomeError('路径必须是绝对路径', 400, 'invalid_home')

    if (input.mode === 'adopt') {
      const real = await resolveRequestedHome(target)
      return this.register(real, input.name)
    }

    if (input.mode === 'init' || input.mode === 'clone') {
      // 只创建最后一级：上级目录必须已存在，避免打错路径时静默生成整条无意义目录链。
      const parent = dirname(target)
      if (!isDirectory(parent)) {
        throw new HomeError(`上级目录不存在：${parent}`, 400, 'parent_not_found')
      }
      if (existsSync(target)) {
        const stats = statSync(target)
        if (!stats.isDirectory()) throw new HomeError(`路径已存在且不是目录：${target}`, 400, 'invalid_home')
        if (readdirSync(target).length > 0) {
          throw new HomeError(
            `目录非空，无法${input.mode === 'init' ? '初始化' : '复制'}：${target}`,
            409,
            'not_empty',
          )
        }
      }
      if (input.mode === 'clone') {
        if (!input.from) throw new HomeError('复制需要指定来源 pi home', 400, 'invalid_request')
        const from = await resolveRequestedHome(input.from)
        mkdirSync(target, { mode: 0o700 })
        cloneHome(from, target, input.includeAuth === true)
      } else {
        mkdirSync(target, { mode: 0o700 })
        initialiseHome(target)
      }
      const real = await resolveRequestedHome(target)
      return this.register(real, input.name)
    }

    throw new HomeError(`未知的新增模式：${String(input.mode)}`, 400, 'invalid_request')
  }

  private async register(realPath: string, name?: string): Promise<HomeSummary> {
    const id = homeIdOf(realPath)
    for (const entry of this.entries.values()) {
      if (entry.path === realPath) {
        throw new HomeError(`目录已在清单中：${entry.name}`, 409, 'exists')
      }
    }
    const entry: HomeEntry = {
      id,
      name: name?.trim() || basename(realPath) || realPath,
      path: realPath,
    }
    this.entries.set(id, entry)
    await this.persist()
    return this.list().find((h) => h.id === id)!
  }

  /** 改名 / 编辑说明；只动清单元数据。 */
  async update(id: string, patch: { name?: string; description?: string }): Promise<HomeSummary> {
    const entry = this.entries.get(id)
    if (!entry) throw new HomeError(`pi home 不在清单中：${id}`, 404, 'home_not_found')
    const hasName = typeof patch.name === 'string'
    const hasDescription = typeof patch.description === 'string'
    if (!hasName && !hasDescription) {
      throw new HomeError('name 与 description 至少提供一项', 400, 'invalid_request')
    }
    const next: HomeEntry = { ...entry }
    if (hasName) {
      const name = patch.name!.trim()
      if (!name) throw new HomeError('name 不能为空', 400, 'invalid_request')
      if (name.length > 120) throw new HomeError('name 超过 120 字符', 400, 'invalid_request')
      next.name = name
    }
    if (hasDescription) {
      const description = patch.description!.trim()
      if (description.length > 500) throw new HomeError('description 超过 500 字符', 400, 'invalid_request')
      next.description = description || undefined
    }
    this.entries.set(id, next)
    await this.persist()
    return this.list().find((h) => h.id === id)!
  }

  /** 从清单移除；不动文件系统。 */
  async remove(id: string): Promise<void> {
    if (!this.entries.has(id)) {
      throw new HomeError(`pi home 不在清单中：${id}`, 404, 'home_not_found')
    }
    this.entries.delete(id)
    await this.persist()
  }
}

function parseEntry(item: unknown, stateFile: string): HomeEntry {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`状态文件条目必须是对象：${stateFile}`)
  }
  const raw = item as Record<string, unknown>
  const path = raw.path
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`状态文件条目 path 必须是绝对路径：${stateFile}`)
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : basename(path)
  const description = typeof raw.description === 'string' ? raw.description : undefined
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : homeIdOf(path),
    name,
    path,
    description,
  }
}

// ---------------------------------------------------------------------------
// 初始化与复制
// ---------------------------------------------------------------------------

/** 一份默认配置：pi 在缺省文件时用内置默认，因此骨架只保证目录结构存在。 */
export function initialiseHome(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const settings = join(root, 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, '{}\n', { encoding: 'utf8', mode: 0o600 })
  for (const dir of ['skills', 'agents']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 })
}

/** 从来源 home 复制的条目；auth.json 与运行态目录不在其中。 */
const CLONE_FILES = ['settings.json', 'models.json', 'mcp.json']
const CLONE_DIRS = ['skills', 'agents', 'prompts', 'themes']

export interface CloneReport {
  files: string[]
  dirs: string[]
  /** 显式跳过的条目（含原因）。 */
  skipped: Array<{ name: string; reason: string }>
}

/**
 * 复制配置到 target。凭据（auth.json）默认不复制：它属于账号身份而非配置，
 * 复制会把凭据悄悄带到另一份 home 里。需要时由调用方显式开启。
 * 会话、日志、已安装的 npm 包同样跳过（体积大且与来源绑定）。
 */
export function cloneHome(from: string, target: string, includeAuth = false): CloneReport {
  const report: CloneReport = { files: [], dirs: [], skipped: [] }
  for (const name of CLONE_FILES) {
    const src = join(from, name)
    if (!existsSync(src)) continue
    cpSync(src, join(target, name), { preserveTimestamps: true })
    report.files.push(name)
  }
  for (const name of CLONE_DIRS) {
    const src = join(from, name)
    if (!isDirectory(src)) continue
    cpSync(src, join(target, name), { recursive: true, preserveTimestamps: true })
    report.dirs.push(name)
  }
  if (existsSync(join(from, 'auth.json'))) {
    if (includeAuth) {
      const authCopy = join(target, 'auth.json')
      cpSync(join(from, 'auth.json'), authCopy, { preserveTimestamps: true })
      // 凭据文件必须保持私有权限。
      chmodSync(authCopy, 0o600)
      report.files.push('auth.json')
    } else {
      report.skipped.push({ name: 'auth.json', reason: '凭据属于账号身份，默认不复制' })
    }
  }
  for (const name of ['sessions', 'logs', 'npm', 'bin']) {
    if (existsSync(join(from, name))) {
      report.skipped.push({ name, reason: '运行态或已安装依赖，与来源绑定' })
    }
  }
  // 复制来的 home 至少要有 settings.json，否则算不上一份可用配置。
  const settings = join(target, 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, '{}\n', { encoding: 'utf8', mode: 0o600 })
  return report
}

/** 供测试与冒烟：判断路径是否已是一份可用的 pi home。 */
export function isPiHome(path: string): boolean {
  return looksLikePiHome(path)
}
