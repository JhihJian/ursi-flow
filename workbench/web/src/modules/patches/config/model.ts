import type { Entry } from '@/modules/directories/api'

/** 配置补丁的三个锚点：创建补丁时由服务端写入，界面不提供移动和删除。 */
export const PROMPT_PATH = 'AGENTS.md'
export const MCP_PATH = 'mcp.json'
export const SKILLS_ROOT = 'skills'

export type ConfigTab = 'overview' | 'prompt' | 'skills' | 'mcp'

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/** `skills/` 的直接子目录即一个 Skill；更深的目录属于该 Skill 的附属文件。 */
export function skillNames(entries: Entry[]): string[] {
  const prefix = `${SKILLS_ROOT}/`
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !entry.path.startsWith(prefix)) continue
    const rest = entry.path.slice(prefix.length)
    if (!rest || rest.includes('/')) continue
    names.add(rest)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function skillPath(name: string): string {
  return `${SKILLS_ROOT}/${name}`
}

export function skillEntryPath(name: string): string {
  return `${skillPath(name)}/SKILL.md`
}

/** 空字符串表示名称可用；其余是直接呈现给经办人的原因。 */
export function skillNameError(name: string, existing: string[]): string {
  const value = name.trim()
  if (!value) return '请输入 Skill 名称。'
  if (value.length > 64) return 'Skill 名称不能超过 64 个字符。'
  if (!SKILL_NAME_PATTERN.test(value)) return 'Skill 名称只接受小写字母、数字、点、短横线和下划线，并以字母或数字开头。'
  if (existing.includes(value)) return '已有同名 Skill，请换一个名称。'
  return ''
}

/** 新 Skill 的入口文件：带 frontmatter 的骨架，正文留给经办人填写。 */
export function skillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: 说明这个 Skill 的用途和触发时机。',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n')
}

/**
 * mcp.json 的写入约束：合法 JSON、顶层是对象；出现 mcpServers 时它也得是对象。
 * 返回空字符串表示可以保存。
 */
export function mcpError(text: string): string {
  if (!text.trim()) return '内容不能为空，至少要保留 {"mcpServers":{}}。'
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return `JSON 无法解析：${cause instanceof Error ? cause.message : String(cause)}`
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '顶层必须是 JSON 对象。'
  const servers = (value as Record<string, unknown>).mcpServers
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return 'mcpServers 必须是 JSON 对象。'
  }
  return ''
}
