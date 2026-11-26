import { join } from 'node:path'
import { readdirSync, readFileSync, statSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ConflictError, readSnapshotSync, type FileSnapshot } from '../shared/rw.ts'
import {
  blockValue,
  renderBlock,
  renderRawBlock,
  splitFrontmatter,
  stringList,
  stringValue,
  type FrontmatterBlock,
} from '../shared/frontmatter.ts'

/**
 * agents/ 目录的 subagent profile 管理。
 *
 * profile 文件 = YAML frontmatter + 正文系统提示词。本模块只编辑 pi-web Agents 面板
 * 同一组受管 key（description/display_name/tools/load_skills/load_extensions/codemode/
 * mcp/enabled/inherit_context/run_in_background/prompt_mode/model/thinking/max_turns/
 * color/isolation/persist_session），其余 frontmatter key 逐块原样保留。
 *
 * 语义边界（与 pi-web 一致）：
 * - `skills:` / `extensions:` 白名单不是本页可编辑项，原样保留；开关只写 load_skills /
 *   load_extensions。文件只有白名单时，开关按 pi 的规则读出「已开启」，但保存不改白名单。
 * - `codemode: inherit|on|off`，缺省为 off；`mcp: on|off`，缺省为 off。
 * - `tools: none` 表示空工具集，`all` / `*` 表示 pi 的默认工具集。
 */

export type AgentCodemode = 'off' | 'inherit' | 'on'
export type AgentMcp = 'off' | 'on'
export type AgentPromptMode = 'append' | 'replace'
export type AgentIsolation = 'worktree' | 'off'

export interface AgentProfileFields {
  displayName: string | null
  model: string | null
  thinking: string | null
  /** null 表示文件未写 tools（跟随 pi 默认）。 */
  tools: string[] | null
  loadSkills: boolean
  loadExtensions: boolean
  codemode: AgentCodemode
  mcp: AgentMcp
  enabled: boolean
  inheritContext: boolean
  runInBackground: boolean
  promptMode: AgentPromptMode
  maxTurns: number | null
  color: string | null
  isolation: AgentIsolation | null
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
  /** frontmatter 里实际出现的受管 key（保存时决定写不写默认值）。 */
  presentKeys: string[]
  /** 未受管 key 的原样文本行（含缩进续行）。 */
  extraKeys: string[]
  /** 第一个 key 之前的注释/空行，保存时原样放回。 */
  preamble: string[]
  /** 受管 key 的原始块（保存时值未变就原样重放，保住注释与块标量）。 */
  rawBlocks: Record<string, FrontmatterBlock>
  /** 值不是标准写法、只能原样保留的受管 key（页面提示，不做结构化解构）。 */
  unparsedKeys: string[]
  body: string
  revision: string
  bytes: number
}

export interface AgentsSettings {
  builtInEnabled: boolean
  disabledBuiltIns: string[]
  maxConcurrent: number
  path: string
  exists: boolean
  revision: string
}

const MANAGED_KEYS = new Set([
  'name',
  'description',
  'display_name',
  'tools',
  'load_skills',
  'load_extensions',
  'codemode',
  'mcp',
  'enabled',
  'inherit_context',
  'run_in_background',
  'prompt_mode',
  'model',
  'thinking',
  'max_turns',
  'color',
  'isolation',
  'persist_session',
])

/** pi 的 thinking 级别；与 settings.json 的 defaultThinkingLevel 一致。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const DEFAULT_TOOL_LIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

export function agentsDir(home: string): string {
  return join(home, 'agents')
}

export function agentsSettingsPath(home: string): string {
  return join(agentsDir(home), 'settings.json')
}

export function listAgentProfiles(home: string): AgentProfile[] {
  const dir = agentsDir(home)
  if (!existsSync(dir)) return []
  const profiles: AgentProfile[] = []
  for (const entry of iterateDir(dir)) {
    if (!entry.endsWith('.md')) continue
    const full = join(dir, entry)
    try {
      profiles.push(parseProfile(entry, readFileSync(full, 'utf8'), full))
    } catch {
      // 解析失败的文件跳过，不影响其余条目。
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name))
  return profiles
}

export function readAgentProfile(home: string, file: string): AgentProfile {
  const full = join(agentsDir(home), file)
  return parseProfile(file, readFileSync(full, 'utf8'), full)
}

function iterateDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isFile())
  } catch {
    return []
  }
}

function resourceSwitch(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'string' && ['none', 'false'].includes(value.trim().toLowerCase())) return false
  if (typeof value === 'boolean') return value
  return Array.isArray(value) || typeof value === 'string' ? true : fallback
}

function nameList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const names = stringList(value)
    return names.length > 0 ? names : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (['true', 'false', 'none', 'all'].includes(trimmed)) return null
    const names = stringList(value)
    return names.length > 0 ? names : null
  }
  return null
}

function parseTools(value: unknown): string[] | null {
  if (value === undefined) return null
  const names = stringList(value)
  if (names.includes('none')) return []
  if (names.includes('all') || names.includes('*')) return [...DEFAULT_TOOL_LIST]
  return names
}

function parseProfile(fileName: string, text: string, fullPath: string): AgentProfile {
  const info = statSync(fullPath)
  const { blocks, preamble, body } = splitFrontmatter(text)
  const byKey = new Map(blocks.map((block) => [block.key, block]))
  const presentKeys: string[] = []
  const extraKeys: string[] = []
  const rawBlocks: Record<string, FrontmatterBlock> = {}
  const unparsedKeys: string[] = []
  const known = new Set(MANAGED_KEYS)
  for (const block of blocks) {
    if (!known.has(block.key)) {
      extraKeys.push(...renderRawBlock(block))
      continue
    }
    presentKeys.push(block.key)
    rawBlocks[block.key] = block
  }

  const name = stringValue(byKey.get('name')) ?? fileName.replace(/\.md$/, '')
  const description = stringValue(byKey.get('description')) ?? ''
  const valueOf = (key: string): unknown => {
    const block = byKey.get(key)
    return block ? blockValue(block) : undefined
  }
  const stringOf = (key: string): string | null => stringValue(byKey.get(key))
  const skillsAlias = nameList(valueOf('skills'))
  const extensionsAlias = nameList(valueOf('extensions'))
  const codemodeRaw = valueOf('codemode')
  const mcpRaw = valueOf('mcp')
  const thinking = stringOf('thinking')
  const maxTurnsRaw = valueOf('max_turns')
  const isolation = stringOf('isolation')

  for (const block of blocks) {
    if (!known.has(block.key)) continue
    const value = blockValue(block)
    if (
      (block.key === 'thinking' && value !== undefined && !(THINKING_LEVELS as readonly string[]).includes(String(value)))
      || (block.key === 'max_turns' && value !== undefined && !(typeof value === 'number' && value > 0))
      || (block.key === 'isolation' && value !== undefined && value !== 'worktree' && value !== 'off')
      || (block.key === 'persist_session' && value !== undefined && typeof value !== 'boolean')
      || (block.key === 'codemode' && value !== undefined && value !== 'on' && value !== 'off' && value !== 'inherit' && value !== true)
      || (block.key === 'mcp' && value !== undefined && value !== 'on' && value !== 'off' && value !== true)
      || (block.key === 'prompt_mode' && value !== undefined && value !== 'append' && value !== 'replace')
    ) {
      unparsedKeys.push(block.key)
    }
  }

  const fields: AgentProfileFields = {
    displayName: stringOf('display_name'),
    model: stringOf('model'),
    thinking: thinking && (THINKING_LEVELS as readonly string[]).includes(thinking) ? thinking : null,
    tools: parseTools(valueOf('tools')),
    loadSkills: resourceSwitch(
      byKey.has('load_skills') ? valueOf('load_skills') : skillsAlias ?? undefined,
      false,
    ),
    loadExtensions: resourceSwitch(
      byKey.has('load_extensions') ? valueOf('load_extensions') : extensionsAlias ?? undefined,
      false,
    ),
    codemode: codemodeRaw === 'on' || codemodeRaw === true
      ? 'on'
      : codemodeRaw === 'inherit' ? 'inherit' : 'off',
    mcp: mcpRaw === 'on' || mcpRaw === true ? 'on' : 'off',
    enabled: valueOf('enabled') === false ? false : true,
    inheritContext: valueOf('inherit_context') === true,
    runInBackground: valueOf('run_in_background') === true,
    promptMode: valueOf('prompt_mode') === 'replace' ? 'replace' : 'append',
    maxTurns: typeof maxTurnsRaw === 'number' && maxTurnsRaw > 0 ? Math.floor(maxTurnsRaw) : null,
    color: stringOf('color'),
    isolation: isolation === 'worktree' || isolation === 'off' ? isolation : null,
    persistSession: typeof valueOf('persist_session') === 'boolean'
      ? (valueOf('persist_session') as boolean)
      : null,
    skillsAlias,
    extensionsAlias,
  }

  return {
    file: fileName,
    name,
    description,
    fields,
    presentKeys,
    extraKeys,
    preamble,
    rawBlocks,
    unparsedKeys,
    body,
    revision: `${Math.round(info.mtimeMs)}.${info.size}`,
    bytes: Buffer.byteLength(text),
  }
}

export interface AgentProfileInput {
  name: string
  description: string
  fields: AgentProfileFields
  presentKeys: readonly string[]
  extraKeys: readonly string[]
  body: string
}

function assertChoice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConflictError(`${label} 只能是：${allowed.join(' / ')}`)
  }
  return value as T
}

function sameField(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 校验结构化输入并渲染 frontmatter。
 *
 * `current` 是磁盘上现有的 profile：受管 key 的值没变时重放原始块，因此注释、
 * 块标量（`description: |`）、手写格式都不会因为一次无关保存而丢失；只有真正
 * 改动的 key 才写成 canonical 形式。
 */
export function renderProfile(profile: AgentProfileInput, current?: AgentProfile): string {
  const name = profile.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ConflictError('name 只能包含字母数字与 ._-，且以字母数字开头')
  }
  const fields = profile.fields
  const present = new Set(current?.presentKeys ?? profile.presentKeys)
  const lines: string[] = []
  if (current) lines.push(...current.preamble)

  const raw = (key: string): string[] | null => {
    if (!current) return null
    const block = current.rawBlocks[key]
    if (!block) return null
    return sameField(fields[key as keyof AgentProfileFields], current.fields[key as keyof AgentProfileFields])
      ? renderRawBlock(block)
      : null
  }

  const write = (
    frontmatterKey: string,
    fieldKey: keyof AgentProfileFields,
    value: string | number | boolean | readonly string[],
    isDefault: boolean,
  ) => {
    const unchanged = raw(frontmatterKey)
    if (unchanged) {
      lines.push(...unchanged)
      return
    }
    if (!present.has(frontmatterKey) && isDefault) return
    lines.push(renderBlock(frontmatterKey, value))
  }

  /** 可缺省的字段：清空时删键，未改动时重放原始块。 */
  const writeOptional = (
    frontmatterKey: string,
    fieldKey: keyof AgentProfileFields,
    value: string | number | boolean | readonly string[] | null,
  ) => {
    const unchanged = raw(frontmatterKey)
    if (unchanged) {
      lines.push(...unchanged)
      return
    }
    if (value === null) return
    if (Array.isArray(value) && value.length === 0 && fieldKey === 'tools') {
      lines.push(renderBlock(frontmatterKey, ['none']))
      return
    }
    lines.push(renderBlock(frontmatterKey, value))
  }

  lines.push(renderBlock('name', name))
  lines.push(renderBlock('description', profile.description.trim()))

  writeOptional('display_name', 'displayName', fields.displayName && fields.displayName !== name ? fields.displayName : null)
  writeOptional('model', 'model', fields.model)
  writeOptional('thinking', 'thinking', fields.thinking ? assertChoice(fields.thinking, THINKING_LEVELS, 'thinking') : null)
  writeOptional('max_turns', 'maxTurns', fields.maxTurns !== null && fields.maxTurns > 0 ? Math.floor(fields.maxTurns) : null)
  writeOptional('tools', 'tools', fields.tools)
  write('load_skills', 'loadSkills', fields.loadSkills, fields.loadSkills === false)
  write('load_extensions', 'loadExtensions', fields.loadExtensions, fields.loadExtensions === false)
  write('codemode', 'codemode', assertChoice(fields.codemode, ['off', 'inherit', 'on'], 'codemode'), fields.codemode === 'off')
  write('mcp', 'mcp', assertChoice(fields.mcp, ['off', 'on'], 'mcp'), fields.mcp === 'off')
  write('enabled', 'enabled', fields.enabled, fields.enabled === true)
  write('inherit_context', 'inheritContext', fields.inheritContext, fields.inheritContext === false)
  write('run_in_background', 'runInBackground', fields.runInBackground, fields.runInBackground === false)
  write('prompt_mode', 'promptMode', assertChoice(fields.promptMode, ['append', 'replace'], 'prompt_mode'), fields.promptMode === 'append')
  writeOptional('color', 'color', fields.color)
  writeOptional('isolation', 'isolation', fields.isolation ? assertChoice(fields.isolation, ['worktree', 'off'], 'isolation') : null)
  writeOptional('persist_session', 'persistSession', fields.persistSession)

  lines.push(...validateExtraKeys(profile.extraKeys))
  const body = profile.body.replace(/^\n+/, '')
  return `---\n${lines.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

/** 未受管 key 只接受根级 key 行与其缩进续行；受管 key 不允许重复出现在这里。 */
function validateExtraKeys(extraKeys: readonly string[]): string[] {
  const out: string[] = []
  let hasRoot = false
  for (const line of extraKeys) {
    if (line.trim() === '') continue
    const root = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line)
    if (root) {
      if (MANAGED_KEYS.has(root[1])) {
        throw new ConflictError(`受管 key ${root[1]} 请用表单编辑，不要写进“其它 frontmatter key”`)
      }
      hasRoot = true
      out.push(line)
      continue
    }
    if (!hasRoot || !/^\s/.test(line)) {
      throw new ConflictError(`无法识别的 frontmatter 行：${line.trim()}（需要 key: value 或缩进续行）`)
    }
    out.push(line)
  }
  return out
}

export async function saveAgentProfile(
  home: string,
  file: string,
  expectedRevision: string | undefined,
  content: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)) {
    throw new ConflictError('profile 文件名只能是字母数字与 ._-')
  }
  const dir = agentsDir(home)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  if (expectedRevision !== undefined && existsSync(path)) {
    const info = statSync(path)
    const current = `${Math.round(info.mtimeMs)}.${info.size}`
    if (current !== expectedRevision) {
      throw new ConflictError('profile 已被其他进程修改，请刷新后重试')
    }
  }
  const tmp = join(dir, `.${file}.${process.pid}.${randomUUID()}.manager-tmp`)
  if (existsSync(path)) copyFileSync(path, join(dir, `${file}.bak-manager`))
  await writeFile(tmp, content, { mode: 0o600 })
  // 写入前复核一次 revision（读取与写盘之间可能隔了网络 I/O）。
  if (expectedRevision !== undefined && existsSync(path)) {
    const info = statSync(path)
    const current = `${Math.round(info.mtimeMs)}.${info.size}`
    if (current !== expectedRevision) {
      await unlink(tmp).catch(() => {})
      throw new ConflictError('profile 已被其他进程修改，请刷新后重试')
    }
  }
  await rename(tmp, path)
  const written = statSync(path)
  return `${Math.round(written.mtimeMs)}.${written.size}`
}

export async function deleteAgentProfile(home: string, file: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)) {
    throw new ConflictError('profile 文件名只能是字母数字与 ._-')
  }
  await unlink(join(agentsDir(home), file))
}

export function readAgentsSettings(home: string): AgentsSettings {
  const path = agentsSettingsPath(home)
  if (!existsSync(path)) {
    return { builtInEnabled: true, disabledBuiltIns: [], maxConcurrent: 10, path, exists: false, revision: '' }
  }
  const snap = readSnapshotSync<Record<string, unknown>>(path, (text) => {
    const parsed = JSON.parse(text) as Record<string, unknown>
    return parsed ?? {}
  })
  const data = snap.data
  const disabled = Array.isArray(data.disabledBuiltIns)
    ? (data.disabledBuiltIns as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return {
    builtInEnabled: data.builtInEnabled === undefined ? true : data.builtInEnabled === true,
    disabledBuiltIns: disabled,
    maxConcurrent: typeof data.maxConcurrent === 'number' && data.maxConcurrent > 0 ? Math.floor(data.maxConcurrent) : 10,
    path,
    exists: true,
    revision: snap.revision,
  }
}

export async function writeAgentsSettings(
  home: string,
  expectedRevision: string,
  settings: Omit<AgentsSettings, 'path' | 'exists' | 'revision'>,
): Promise<string> {
  const path = agentsSettingsPath(home)
  const text = `${JSON.stringify(
    {
      version: 1,
      builtInEnabled: settings.builtInEnabled,
      disabledBuiltIns: settings.disabledBuiltIns,
      maxConcurrent: settings.maxConcurrent,
    },
    null,
    2,
  )}\n`
  const { writeFile: wf } = await import('node:fs/promises')
  const dir = agentsDir(home)
  const tmp = join(dir, '.settings.json.manager-tmp')
  if (existsSync(path)) copyFileSync(path, join(dir, 'settings.json.bak-manager'))
  await wf(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
  const info = statSync(path)
  return `${Math.round(info.mtimeMs)}.${info.size}`
}

export type { FileSnapshot }
