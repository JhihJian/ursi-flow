import { describe, expect, it } from 'vitest'
import { buildTaskMarkdown } from './task-markdown'

describe('buildTaskMarkdown', () => {
  it('writes title, meta and body as a markdown document', () => {
    const markdown = buildTaskMarkdown({
      title: '部署完成',
      status: 'in_progress',
      priority: 'high',
      tags: ['ops', 'release'],
      note: '## 内容\n\n- 一项',
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
        '## 内容',
        '',
        '- 一项',
        '',
      ].join('\n'),
    )
  })

  it('skips empty tags, empty body and falls back for a blank title', () => {
    expect(
      buildTaskMarkdown({
        title: '   ',
        status: 'pending',
        priority: 'low',
        tags: [],
        note: '   ',
        timeInfo: null,
      }),
    ).toBe('# Untitled task\n\n- Status: pending\n- Priority: low\n')
  })
})
