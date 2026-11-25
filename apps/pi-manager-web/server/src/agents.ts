import { join } from 'node:path'
import { readdirSync, readFileSync, statSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { ConflictError, readSnapshotSync, type FileSnapshot } from './rw.ts'

/**
 * agents/ 目录的 subagent profile 管理。
 *
 * profile 文件 = YAML frontmatter（name/description/model/tools/…）+ 正文系统提示词。
 * 作用域语义与 pi 一致：同名时 project > workspace > global > builtin 遮蔽，
 * 本模块只管 global（<home>/agents/）这一层；builtin 禁用列表在
 * agents/settings.json（pi 的 subagent-settings 专用文件，不是主 settings.json）。
 */

export interface AgentProfile {
  file: string
  name: string
  description: string
  /** frontmatter 其余根级 key 的原样文本（每行一条）。 */
  extraKeys: string[]
  /** 正文（frontmatter 之后的内容）。 */
  body: string
  revision: string
  bytes: number
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export const KNOWN_KEYS = ['name', 'description'] as const

export interface AgentsSettings {
  builtInEnabled: boolean
  disabledBuiltIns: string[]
  maxConcurrent: number
  path: string
  exists: boolean
  revision: string
}

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
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    try {
      profiles.push(parseProfile(entry, text, full))
    } catch {
      // 解析失败的文件跳过。
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name))
  return profiles
}

function iterateDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isFile())
  } catch {
    return []
  }
}

function parseProfile(fileName: string, text: string, fullPath: string): AgentProfile {
  const m = FRONTMATTER_RE.exec(text)
  const info = statSync(fullPath)
  const fmLines = m ? m[1].split(/\r?\n/) : []
  const scalar = (key: string): string => {
    for (const line of fmLines) {
      const km = new RegExp(`^([A-Za-z][A-Za-z0-9_-]*):\\s*(.*)$`).exec(line)
      if (km && km[1] === key) return km[2].replace(/^["']|["']$/g, '').trim()
    }
    return ''
  }
  const extraKeys: string[] = []
  for (const line of fmLines) {
    const km = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line)
    if (km && !(KNOWN_KEYS as readonly string[]).includes(km[1])) extraKeys.push(line)
  }
  return {
    file: fileName,
    name: scalar('name') || fileName.replace(/\.md$/, ''),
    description: scalar('description'),
    extraKeys,
    body: m ? text.slice(m[0].length).replace(/^\r?\n/, '') : text,
    revision: `${Math.round(info.mtimeMs)}.${info.size}`,
    bytes: Buffer.byteLength(text),
  }
}

export function renderProfile(profile: {
  name: string
  description: string
  extraKeys: readonly string[]
  body: string
}): string {
  const fm = ['---', `name: ${profile.name}`, `description: ${profile.description}`, ...profile.extraKeys, '---', '', profile.body]
  return fm.join('\n').endsWith('\n') ? fm.join('\n') : `${fm.join('\n')}\n`
}

export async function saveAgentProfile(
  home: string,
  file: string,
  expectedRevision: string | undefined,
  content: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(file)) {
    throw new ConflictError('profile 文件名只能是字母数字与 -_')
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
  const tmp = join(dir, `.${file}.manager-tmp`)
  if (existsSync(path)) copyFileSync(path, join(dir, `${file}.bak-manager`))
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
  const written = statSync(path)
  return `${Math.round(written.mtimeMs)}.${written.size}`
}

export async function deleteAgentProfile(home: string, file: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(file)) {
    throw new ConflictError('profile 文件名只能是字母数字与 -_')
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
