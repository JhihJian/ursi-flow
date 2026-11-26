import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { ConflictError } from './rw.ts'

/**
 * skills/ 目录扫描与 SKILL.md frontmatter 的外科式开关。
 *
 * SKILL.md 是 YAML frontmatter + Markdown 正文。disable-model-invocation
 * 的切换不能走"解析 YAML 再序列化"（会重排格式、丢注释、误伤嵌套同名 key），
 * 只做根级 key 的行级插入或删除，frontmatter 其余字节一律不动。
 */

export interface SkillInfo {
  /** 相对 skills/ 的目录路径（嵌套目录用 / 分隔）。 */
  relDir: string
  name: string
  description: string
  disableModelInvocation: boolean
  /** SKILL.md 相对 home 的路径。 */
  filePath: string
  revision: string
  bytes: number
}

const FRONTMATTER_RE = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function fileRevision(path: string): string {
  const info = statSync(path)
  return `${Math.round(info.mtimeMs)}.${info.size}`
}

function rootKeyLine(frontmatter: string, key: string): number {
  const lines = frontmatter.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // 根级 key：行首无空白。嵌套 key 有缩进，不匹配。
    const m = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line)
    if (m && m[1] === key) return i
  }
  return -1
}

export function readDisableModelInvocation(path: string): boolean {
  const text = readFileSync(path, 'utf8')
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return false
  const idx = rootKeyLine(m[1], 'disable-model-invocation')
  if (idx < 0) return false
  const line = m[1].split(/\r?\n/)[idx]
  const value = line.slice(line.indexOf(':') + 1).trim().toLowerCase()
  return value === 'true'
}

/** 外科式切换：只在根级插入或删除一行，其余字节保持。返回新文本。 */
export function toggleDisableModelInvocation(text: string, disabled: boolean): string {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) throw new Error('SKILL.md 缺少 frontmatter，无法记录开关')
  const frontmatter = m[1]
  const lines = frontmatter.split(/\r?\n/)
  const idx = rootKeyLine(frontmatter, 'disable-model-invocation')
  let next: string[]
  if (disabled) {
    if (idx >= 0) {
      const line = lines[idx]
      const rest = line.slice(line.indexOf(':') + 1).trim().toLowerCase()
      if (rest === 'true') return text
      lines[idx] = 'disable-model-invocation: true'
      next = lines
    } else {
      lines.push('disable-model-invocation: true')
      next = lines
    }
  } else {
    if (idx < 0) return text
    const line = lines[idx]
    const rest = line.slice(line.indexOf(':') + 1).trim().toLowerCase()
    if (rest !== 'true') return text
    lines.splice(idx, 1)
    next = lines
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  // 原文本 frontmatter 之后的正文 = text.slice(m[0].length)；m[0] 含闭合 --- 行及其换行。
  return `---${eol}${next.join(eol)}${eol}---${eol}${text.slice(m[0].length)}`
}

async function walkSkillDirs(root: string, rel: string, out: string[]): Promise<void> {
  const dir = join(root, rel)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const relPath = rel ? `${rel}/${entry}` : entry
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (existsSync(join(full, 'SKILL.md'))) out.push(relPath)
      else await walkSkillDirs(root, relPath, out)
    }
  }
}

export interface SkillsListing {
  skills: SkillInfo[]
  /** settings.json 里声明但本目录不存在的额外 skill 路径数。 */
  warnings: string[]
}

export interface SkillFrontmatterEntry {
  key: string
  /** 原样值（缩进续行已合并为多行）。 */
  value: string
}

export interface SkillContent {
  relDir: string
  filePath: string
  raw: string
  /** 按原顺序的根级 frontmatter 条目；没有 frontmatter 为空数组。 */
  frontmatter: SkillFrontmatterEntry[]
  /** frontmatter 之后的 Markdown 正文。 */
  body: string
  bytes: number
  revision: string
}

/** relDir 只能是 skills/ 下的相对目录；同时兼容 / 与 \ 分隔符。 */
function skillFilePath(home: string, relDir: string): string {
  if (!relDir || isAbsolute(relDir) || relDir.split(/[\\/]/).some((part) => part === '' || part === '..')) {
    throw new ConflictError('relDir 越界')
  }
  const root = join(home, 'skills')
  const full = join(root, relDir, 'SKILL.md')
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ConflictError('relDir 越界')
  return full
}

/** 外科式切换一个 skill 的 disable-model-invocation，写前备份。 */
export async function toggleSkill(home: string, relDir: string, disabled: boolean): Promise<boolean> {
  const path = skillFilePath(home, relDir)
  const text = await readFile(path, 'utf8')
  const next = toggleDisableModelInvocation(text, disabled)
  if (next !== text) {
    const { copyFile, rename, writeFile } = await import('node:fs/promises')
    const { randomUUID } = await import('node:crypto')
    await copyFile(path, `${path}.bak-manager`)
    const tmp = `${path}.${process.pid}.${randomUUID()}.manager-tmp`
    await writeFile(tmp, next, { mode: 0o600 })
    await rename(tmp, path)
  }
  return readDisableModelInvocation(path)
}

/** 读取一个 skill 的完整内容：frontmatter 原条目 + 正文。 */
export async function readSkillContent(home: string, relDir: string): Promise<SkillContent> {
  const full = skillFilePath(home, relDir)
  const text = await readFile(full, 'utf8')
  const m = FRONTMATTER_RE.exec(text)
  return {
    relDir,
    filePath: join('skills', relDir, 'SKILL.md'),
    raw: text,
    frontmatter: m ? parseFrontmatterEntries(m[1]) : [],
    body: m ? text.slice(m[0].length) : text,
    bytes: Buffer.byteLength(text),
    revision: fileRevision(full),
  }
}

/** 根级 key 成组：缩进的续行属于上一个 key 的值。 */
function parseFrontmatterEntries(frontmatter: string): SkillFrontmatterEntry[] {
  const entries: SkillFrontmatterEntry[] = []
  for (const line of frontmatter.split(/\r?\n/)) {
    const rm = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (rm) {
      entries.push({ key: rm[1], value: rm[2].trim() })
      continue
    }
    if (entries.length > 0 && /^\s+\S/.test(line)) {
      const last = entries[entries.length - 1]
      last.value = `${last.value}\n${line.trim()}`
    }
  }
  return entries
}

export async function listSkills(home: string): Promise<SkillsListing> {
  const root = join(home, 'skills')
  const relDirs: string[] = []
  await walkSkillDirs(root, '', relDirs)
  const skills: SkillInfo[] = []
  for (const relDir of relDirs) {
    const filePath = join(root, relDir, 'SKILL.md')
    try {
      const text = await readFile(filePath, 'utf8')
      const m = FRONTMATTER_RE.exec(text)
      const fm = m?.[1] ?? ''
      const scalar = (key: string): string => {
        const lines = fm.split(/\r?\n/)
        for (const line of lines) {
          const km = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
          if (km && km[1] === key) return km[2].replace(/^["']|["']$/g, '').trim()
        }
        return ''
      }
      skills.push({
        relDir,
        name: scalar('name') || relDir.split('/').pop() || relDir,
        description: scalar('description'),
        disableModelInvocation: readDisableModelInvocation(filePath),
        filePath: join('skills', relDir, 'SKILL.md'),
        revision: fileRevision(filePath),
        bytes: Buffer.byteLength(text),
      })
    } catch {
      // 读不了的条目跳过，不影响整体列表。
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, warnings: [] }
}
