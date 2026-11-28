/**
 * 从会话文件（JSONL）重放一次会话的运行事实。
 *
 * 会话文件是事实的唯一来源：leading system 消息记录完整的系统提示词分区与工具声明，
 * 之后的 system 消息按名字改分区、按名字增删工具；compaction 条目若带 systemMessage，
 * 就是当时的完整快照。沿当前分支把这些重放一遍，就能还原模型当时看到的 skills 清单、
 * MCP server 与工具集。
 *
 * 只做 JSON 与字符串处理：不读 pi home 的配置目录，也不做任何 IO，输入就是文件内容。
 */

import type { ModelChange, ModelIdentity, SessionFacts, SkillRef } from './types.ts'

/** 会话文件里的一行，形状由 pi 的会话格式决定，这里按需取字段。 */
type Row = Record<string, any>

/** mcp_servers 分区列出的是命名空间 `mcp__<server>`，这里取回 server 名。 */
const MCP_NAMESPACE_PREFIX = 'mcp__'

const MCP_NOTE = '尽力推断：不含连接失败或未暴露工具的 server'

/** SDK parseSkillBlock 同款：整段文本恰好是一次 skill 展开。 */
export const SKILL_BLOCK_PATTERN =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/

/** 同形态的扫描版：一条消息里可能夹着多个块或有前缀文字，取全部出现。 */
const SKILL_BLOCK_SCAN = /<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>/g

/** 提示词 skills 分区里的一个条目：属性式与嵌套标签式写法都认。 */
const SKILL_ENTRY_SCAN = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/g
const SKILL_NAME_ATTR = /\bname="([^"]*)"/
const SKILL_LOCATION_ATTR = /\blocation="([^"]*)"/
const SKILL_NAME_TAG = /<name>([\s\S]*?)<\/name>/
const SKILL_LOCATION_TAG = /<location>([\s\S]*?)<\/location>/

/**
 * 重放会话文件内容。坏行跳过，不抛错：一份会话里有几行坏数据不该让整个事实集消失。
 */
export function replay(jsonl: string): SessionFacts {
  const branch = selectBranch(parseRows(jsonl))

  const sections = new Map<string, string>()
  const tools = new Map<string, string>()
  const readSkills: SkillRef[] = []
  const changes: ModelChange[] = []

  let recorded = false
  let initial: ModelIdentity | null = null
  let current: ModelIdentity | null = null
  let thinkingLevel: string | null = null

  /** 记录一次模型事实，只有与当前生效的模型不同才算切换。 */
  const noteModel = (identity: ModelIdentity, at: number) => {
    if (!identity.provider || !identity.model) return
    if (initial === null) {
      initial = identity
      current = identity
      return
    }
    if (current && current.provider === identity.provider && current.model === identity.model) return
    current = identity
    changes.push({ ...identity, at })
  }

  /**
   * 把一条 system 消息的分区与工具增量应用上去。null 值表示删除该分区。
   * leading system 消息是完整声明、之后的是增量，但重放从空状态开始，同一条增量逻辑就够。
   */
  const applySystem = (message: Row) => {
    recorded = true
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else if (typeof value === 'string') sections.set(name, value)
    }
    for (const tool of message.toolsRemoved ?? []) {
      if (typeof tool?.name === 'string') tools.delete(tool.name)
    }
    for (const tool of message.toolsAdded ?? []) {
      if (typeof tool?.name === 'string') tools.set(tool.name, tool.name)
    }
  }

  /** compaction 的快照是当时的完整状态，整体替换而不是合并。 */
  const applySnapshot = (snapshot: Row) => {
    recorded = true
    sections.clear()
    tools.clear()
    for (const [name, value] of Object.entries(snapshot.sections ?? {})) {
      if (typeof value === 'string') sections.set(name, value)
    }
    for (const tool of snapshot.toolsRemoved ?? []) {
      if (typeof tool?.name === 'string') tools.delete(tool.name)
    }
    for (const tool of snapshot.toolsAdded ?? []) {
      if (typeof tool?.name === 'string') tools.set(tool.name, tool.name)
    }
  }

  for (const row of branch) {
    if (row.type === 'message') {
      const message = row.message
      if (!message || typeof message !== 'object') continue

      if (message.role === 'system') {
        applySystem(message)
        continue
      }

      if (message.role === 'assistant') {
        if (typeof message.provider === 'string' && typeof message.model === 'string') {
          noteModel({ provider: message.provider, model: message.model }, stampOf(row, message))
        }
        if (typeof message.thinkingLevel === 'string') thinkingLevel = message.thinkingLevel
        continue
      }

      if (message.role === 'user') {
        // 展开读取详情是会话级事实：压缩之后模型虽然看不到旧消息，但这次会话确实读过。
        for (const text of textBlocks(message)) {
          for (const match of text.matchAll(SKILL_BLOCK_SCAN)) {
            readSkills.push({ name: match[1], location: match[2] })
          }
        }
        continue
      }

      continue
    }

    if (row.type === 'model_change') {
      noteModel({ provider: row.provider, model: row.modelId }, stampOf(row))
      continue
    }

    if (row.type === 'thinking_level_change') {
      if (typeof row.thinkingLevel === 'string') thinkingLevel = row.thinkingLevel
      continue
    }

    if (row.type === 'compaction') {
      if (row.systemMessage && typeof row.systemMessage === 'object') applySnapshot(row.systemMessage)
      continue
    }
  }

  const listed = recorded ? parseListedSkills(sections.get('skills')) : null
  const servers = recorded ? inferServers(sections.get('mcp_servers'), [...tools.keys()]) : null

  return {
    source: 'file',
    model: { initial, current, thinkingLevel, changes },
    skills: { listed, read: recorded ? readSkills : null },
    mcp: { servers, note: servers === null ? null : MCP_NOTE },
    tools: { names: recorded ? [...tools.keys()] : null },
    promptSectionKeys: recorded ? [...sections.keys()] : null,
    recorded,
    reason: recorded ? undefined : 'not_recorded',
  }
}

/** 逐行解析。空行与坏行跳过，非对象行跳过。 */
function parseRows(jsonl: string): Row[] {
  const rows: Row[] = []
  for (const line of jsonl.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let row: unknown
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    if (!row || typeof row !== 'object') continue
    rows.push(row as Row)
  }
  return rows
}

/**
 * 取当前分支：从最后一条带 id 的行沿 parentId 回溯到根。没有 id 的行没有树上的位置，
 * 按原顺序保留；带 id 但不在分支上的行属于别的分叉，丢弃。
 */
function selectBranch(rows: Row[]): Row[] {
  const byId = new Map<string, number>()
  rows.forEach((row, index) => {
    if (typeof row.id === 'string' && !byId.has(row.id)) byId.set(row.id, index)
  })
  if (byId.size === 0) return rows

  let cursor: string | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (typeof rows[index].id === 'string') {
      cursor = rows[index].id
      break
    }
  }

  const onBranch = new Set<number>()
  const visited = new Set<string>()
  while (typeof cursor === 'string' && !visited.has(cursor)) {
    visited.add(cursor)
    const index = byId.get(cursor)
    if (index === undefined) break
    onBranch.add(index)
    const parentId = rows[index].parentId
    cursor = typeof parentId === 'string' ? parentId : null
  }

  const branch: Row[] = []
  rows.forEach((row, index) => {
    if (onBranch.has(index) || typeof row.id !== 'string') branch.push(row)
  })
  return branch
}

/** 消息里的文本块。content 允许是字符串或块数组。 */
function textBlocks(message: Row): string[] {
  const content = message.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block && typeof block.text === 'string' && block.type !== 'thinking')
    .map((block) => block.text as string)
}

/** 条目时间戳，统一成 epoch 毫秒；认不出来就是 0。 */
function stampOf(row: Row, message?: Row): number {
  const value = row.timestamp ?? message?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * 从提示词 skills 分区解析出清单。formatSkillsForPrompt 产出的是嵌套写法
 * （`<skill><name/><description/><location/></skill>`），属性式写法一样接受；
 * 不去重不排序，保持出现顺序。一个条目都解析不出来就是空数组。
 */
function parseListedSkills(section: string | undefined): SkillRef[] {
  if (!section) return []
  const skills: SkillRef[] = []
  for (const match of section.matchAll(SKILL_ENTRY_SCAN)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const name = pick(attributes, body, SKILL_NAME_ATTR, SKILL_NAME_TAG)
    if (!name) continue
    const location = pick(attributes, body, SKILL_LOCATION_ATTR, SKILL_LOCATION_TAG)
    skills.push({ name, location: location ?? '' })
  }
  return skills
}

function pick(attributes: string, body: string, attribute: RegExp, tag: RegExp): string | null {
  const fromAttribute = attribute.exec(attributes)
  if (fromAttribute) return unescapeXml(fromAttribute[1])
  const fromTag = tag.exec(body)
  if (fromTag) return unescapeXml(fromTag[1].trim())
  return null
}

/** 与 formatSkillsForPrompt 的 escapeXml 对称。 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 推断 MCP server：mcp_servers 分区里的行首命名空间，加上工具名 `mcp__<server>__<tool>` 的前缀。
 * 两处都是尽力而为，合成一份去重后的清单。
 */
function inferServers(section: string | undefined, toolNames: string[]): string[] {
  const servers = new Set<string>()

  for (const line of (section ?? '').split('\n')) {
    // 分区里除 `- mcp__<server> (codemode)` 外还有说明文字与「- … N more servers」的省略行。
    const match = /^-\s+(mcp__\w+)/.exec(line.trim())
    if (match) servers.add(match[1].slice(MCP_NAMESPACE_PREFIX.length))
  }

  for (const name of toolNames) {
    if (!name.startsWith(MCP_NAMESPACE_PREFIX)) continue
    const rest = name.slice(MCP_NAMESPACE_PREFIX.length)
    const cut = rest.indexOf('__')
    if (cut <= 0) continue
    servers.add(rest.slice(0, cut))
  }

  return [...servers]
}
