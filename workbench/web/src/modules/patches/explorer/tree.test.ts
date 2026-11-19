import { describe, expect, it } from 'vitest'

import { ancestorsOf, buildTree, missingAncestors, treePaths, visibleRows } from './tree'
import type { Entry } from '@/modules/directories/api'

const entries: Entry[] = [
  { path: 'AGENTS.md', kind: 'file' },
  { path: 'skills', kind: 'dir' },
  { path: 'skills/review.md', kind: 'file' },
  { path: 'skills/tools', kind: 'dir' },
  { path: 'skills/tools/lint.md', kind: 'file' },
  { path: 'zeta.md', kind: 'file' },
]

describe('文件树', () => {
  it('目录排在文件之前并按名称排序', () => {
    const tree = buildTree(entries)
    expect(tree.children.map(child => [child.name, child.dir])).toEqual([
      ['skills', true],
      ['AGENTS.md', false],
      ['zeta.md', false],
    ])
    expect(tree.children[0]?.children.map(child => child.name)).toEqual(['tools', 'review.md'])
  })

  it('清单缺少中间目录时补成目录节点', () => {
    const tree = buildTree([{ path: 'a/b/c.md', kind: 'file' }])
    const a = tree.children[0]
    const b = a?.children[0]
    expect(a?.dir).toBe(true)
    expect(b?.dir).toBe(true)
    expect(b?.children[0]).toMatchObject({ name: 'c.md', dir: false, path: 'a/b/c.md' })
  })

  it('root 只限制显示范围，节点路径仍是包根相对路径', () => {
    const tree = buildTree(entries, 'skills')
    expect(tree.path).toBe('skills')
    expect(tree.children.map(child => child.path)).toEqual(['skills/tools', 'skills/review.md'])
    const rows = visibleRows(tree, new Set(['skills/tools']))
    expect(rows.map(row => [row.path, row.depth])).toEqual([
      ['skills/tools', 0],
      ['skills/tools/lint.md', 1],
      ['skills/review.md', 0],
    ])
  })

  it('展开状态决定可见行', () => {
    const tree = buildTree(entries)
    expect(visibleRows(tree, new Set()).map(row => row.path)).toEqual(['skills', 'AGENTS.md', 'zeta.md'])
    expect(visibleRows(tree, new Set(['skills'])).map(row => row.path)).toEqual([
      'skills', 'skills/tools', 'skills/review.md', 'AGENTS.md', 'zeta.md',
    ])
  })

  it('打开文件时展开祖先，创建时补齐缺失目录', () => {
    expect(ancestorsOf('skills/tools/lint.md')).toEqual(['skills', 'skills/tools'])
    expect(ancestorsOf('AGENTS.md')).toEqual([])
    expect(ancestorsOf('skills/tools/lint.md', 'skills')).toEqual(['skills/tools'])
    const { files, dirs } = treePaths(buildTree(entries, 'skills'))
    expect(files.has('skills/review.md')).toBe(true)
    expect(dirs.has('skills/tools')).toBe(true)
    expect(missingAncestors('skills/deep/new.md', 'skills', dirs)).toEqual(['skills/deep'])
    expect(missingAncestors('skills/tools/new.md', 'skills', dirs)).toEqual([])
  })
})
