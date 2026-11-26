/**
 * 极小的 YAML frontmatter 读写：只处理根级 key，够用于 agents/*.md 与 SKILL.md。
 *
 * 设计取舍：pi 的文件由 YAML 解析器读取，但管理台只编辑一组受管 key，其余 key
 * 必须原样保留（注释、顺序、未知嵌套）。因此解析时把每个根级 key 连同它的
 * 缩进续行当作一个块保存；受管 key 解析成结构化值，并在保存时按「值是否改动」
 * 决定重放原始块还是写 canonical 形式，未受管块始终原样写回。
 * 不做通用 YAML：流式映射、锚点、多文档等写法会被当作原样块保留，不会被改写。
 */

export interface FrontmatterBlock {
  key: string
  /** key 行之后的值文本（不含 `key:` 前缀），续行保持缩进。 */
  lines: string[]
}

export interface SplitFrontmatter {
  blocks: FrontmatterBlock[]
  /** 第一个 key 之前的行（注释、空行），保存时原样放回。 */
  preamble: string[]
  body: string
  hasFrontmatter: boolean
}

const FRONTMATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export function splitFrontmatter(text: string): SplitFrontmatter {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return { blocks: [], preamble: [], body: text, hasFrontmatter: false }
  const blocks: FrontmatterBlock[] = []
  const preamble: string[] = []
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (km) {
      blocks.push({ key: km[1], lines: [km[2].trim()] })
      continue
    }
    if (blocks.length === 0) {
      // 第一个 key 之前的注释/空行（以及缩进异常的孤立行）原样保留。
      preamble.push(line)
      continue
    }
    if (line.trim() === '' || /^\s/.test(line)) {
      blocks[blocks.length - 1].lines.push(line)
      continue
    }
    // 顶层非 key 行挂到最后一个块，避免丢内容。
    blocks[blocks.length - 1].lines.push(line)
  }
  return { blocks, preamble, body: text.slice(m[0].length), hasFrontmatter: true }
}

function stripComment(value: string): string {
  // 只移除「空格 + #」开头的行尾注释，避免误伤 URL 里的 #。
  return value.replace(/\s+#.*$/, '')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function splitInlineList(raw: string): string[] {
  const body = raw.slice(1, -1)
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of body) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) out.push(current)
  return out.map((item) => unquote(stripComment(item))).filter(Boolean)
}

/** `|` / `>` 块标量：去掉公共缩进，按字面或折叠方式还原文本。 */
function blockScalar(first: string, rest: readonly string[]): string | undefined {
  const indicator = first.trim()
  if (!/^[|>][+-]?\d*$/.test(indicator)) return undefined
  const content = rest.filter((line) => line.trim() !== '')
  if (content.length === 0) return ''
  const indents = content.map((line) => /^\s*/.exec(line)?.[0].length ?? 0)
  const indent = Math.min(...indents)
  const lines = rest.map((line) => line.slice(indent))
  const folded = indicator.startsWith('>')
  const text = folded ? lines.join(' ').replace(/ {2,}/g, ' ') : lines.join('\n')
  return indicator.includes('-') ? text.trimEnd() : `${text.replace(/\s+$/, '')}\n`
}

/** 块的值：标量、字符串数组或块标量文本；空块返回 undefined。 */
export function blockValue(block: FrontmatterBlock): unknown {
  const first = (block.lines[0] ?? '').trim()
  const rest = block.lines.slice(1)
  if (first === '' && rest.length === 0) return undefined
  const scalarBlock = blockScalar(first, rest)
  if (scalarBlock !== undefined) return scalarBlock
  if (first === '' || (first.startsWith('#') && rest.length > 0)) {
    const items = rest
      .map((line) => /^\s*-\s+(.*)$/.exec(line)?.[1])
      .filter((item): item is string => item !== undefined)
      .map((item) => unquote(stripComment(item)))
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (first.startsWith('[') && first.endsWith(']')) return splitInlineList(first)
  const scalar = unquote(stripComment(first))
  if (scalar === '') return undefined
  if (scalar === 'true') return true
  if (scalar === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(scalar)) return Number(scalar)
  return scalar
}

export function stringValue(block: FrontmatterBlock | undefined): string | null {
  if (!block) return null
  const value = blockValue(block)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))]
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
  }
  return []
}

/** YAML 标量渲染：安全标识符原样，其余用双引号（JSON 字符串也是合法 YAML）。 */
export function renderScalar(value: string): string {
  if (/^[A-Za-z0-9_./@:+][A-Za-z0-9_./@:+-]*$/.test(value)) return value
  return JSON.stringify(value)
}

export function renderList(values: readonly string[]): string {
  if (values.length === 0) return '[]'
  return `[${values.map(renderScalar).join(', ')}]`
}

export function renderBlock(key: string, value: string | number | boolean | readonly string[]): string {
  if (Array.isArray(value)) return `${key}: ${renderList(value)}`
  if (typeof value === 'string') return `${key}: ${renderScalar(value)}`
  return `${key}: ${String(value)}`
}

/**
 * 一个原始块的文本行。块标量的 `|` / `>` 行原样保留，不能压缩成一行。
 */
export function renderRawBlock(block: FrontmatterBlock): string[] {
  return [`${block.key}:${block.lines[0] ? ` ${block.lines[0]}` : ''}`, ...block.lines.slice(1)]
}
