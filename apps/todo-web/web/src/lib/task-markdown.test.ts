import { describe, expect, it } from 'vitest'
import { buildTaskMarkdown } from './task-markdown'

describe('buildTaskMarkdown', () => {
  it('writes title, meta, record and result as a markdown document', () => {
    const markdown = buildTaskMarkdown({
      title: '部署完成',
      status: 'in_progress',
      priority: 'high',
      tags: ['ops', 'release'],
      log: '## 过程\n\n- 先编译',
      result: '## 结果\n\n- 已上线',
      timeInfo: 'Created: 2026/11/24',
    })
    expect(markdown).toBe(
      [
        '# 部署完成',
        '',
        '- Status: in_progress',
        '- Priority: high',
        '- Tags: #ops #release',
        '- Time: Created: 2026/11/24',
        '',
        '## Record',
        '',
        '## 过程',
        '',
        '- 先编译',
        '',
        '## Result',
        '',
        '## 结果',
        '',
        '- 已上线',
        '',
      ].join('\n'),
    )
  })

  it('skips empty tags, empty sections and falls back for a blank title', () => {
    expect(
      buildTaskMarkdown({
        title: '   ',
        status: 'pending',
        priority: 'low',
        tags: [],
        log: '过程',
        result: '   ',
        timeInfo: null,
      }),
    ).toBe('# Untitled task\n\n- Status: pending\n- Priority: low\n\n## Record\n\n过程\n')
  })
})
