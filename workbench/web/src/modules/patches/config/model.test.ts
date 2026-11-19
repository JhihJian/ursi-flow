import { describe, expect, it } from 'vitest'
import type { Entry } from '@/modules/directories/api'
import { mcpError, skillEntryPath, skillNameError, skillNames, skillPath, skillTemplate } from './model'

const entry = (path: string, kind: Entry['kind']): Entry => ({ path, kind })

describe('Skills 目录推导', () => {
  it('只把 skills/ 的直接子目录当作 Skill，并忽略文件与根目录本身', () => {
    const entries = [
      entry('skills', 'dir'),
      entry('skills/review', 'dir'),
      entry('skills/review/SKILL.md', 'file'),
      entry('skills/write-notes', 'dir'),
      entry('skills/write-notes/templates', 'dir'),
      entry('skills/README.md', 'file'),
      entry('docs', 'dir'),
    ]
    expect(skillNames(entries)).toEqual(['review', 'write-notes'])
  })

  it('入口路径始终是包根相对路径', () => {
    expect(skillPath('review')).toBe('skills/review')
    expect(skillEntryPath('review')).toBe('skills/review/SKILL.md')
  })
})

describe('Skill 名称校验', () => {
  it('接受小写字母开头的名称，拒绝空值、路径分隔符和重名', () => {
    expect(skillNameError('code-review', [])).toBe('')
    expect(skillNameError('review.2024', [])).toBe('')
    expect(skillNameError('  review  ', [])).toBe('')
    expect(skillNameError('', [])).not.toBe('')
    expect(skillNameError('Review', [])).not.toBe('')
    expect(skillNameError('../escape', [])).not.toBe('')
    expect(skillNameError('a/b', [])).not.toBe('')
    expect(skillNameError('review', ['review'])).not.toBe('')
  })
})

describe('Skill 模板', () => {
  it('带 frontmatter 的 SKILL.md 骨架', () => {
    const text = skillTemplate('review')
    expect(text.startsWith('---\nname: review\n')).toBe(true)
    expect(text).toContain('description:')
    expect(text.trimEnd().endsWith('# review')).toBe(true)
  })
})

describe('mcp.json 合法性', () => {
  it('合法对象、含 mcpServers 对象都可保存', () => {
    expect(mcpError('{"mcpServers":{}}')).toBe('')
    expect(mcpError('{"mcpServers":{"demo":{"command":"npx"}}}')).toBe('')
    expect(mcpError('{}')).toBe('')
  })

  it('空内容、数组、非对象和错误 JSON 都阻止保存', () => {
    expect(mcpError('')).not.toBe('')
    expect(mcpError('[]')).not.toBe('')
    expect(mcpError('"text"')).not.toBe('')
    expect(mcpError('null')).not.toBe('')
    expect(mcpError('{')).toContain('JSON')
    expect(mcpError('{"mcpServers":[]}')).not.toBe('')
  })
})
