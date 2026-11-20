import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import type { Patch } from './api'
import { WorkPatchRow } from './WorkPatchRow'

afterEach(cleanup)

it.each<[Patch['executionStatus'], string, string]>([
  ['not_started', '未执行', '暂无结果'],
  ['running', '已执行', '执行中'],
  ['succeeded', '已执行', '成功'],
  ['failed', '已执行', '失败'],
  [undefined, '未记录', '未记录'],
])('工作包状态 %s 与结果分别展示', (executionStatus, executed, result) => {
  const patch = { id: 'w1', name: '核对', directoryId: 'dir1', executionStatus }
  render(<MemoryRouter><ul><WorkPatchRow patch={patch} /></ul></MemoryRouter>)
  expect(screen.getByText('是否已执行').nextElementSibling).toHaveTextContent(executed)
  expect(screen.getByText('执行结果').nextElementSibling).toHaveTextContent(result)
  expect(screen.getByRole('link', { name: '核对' })).toHaveAttribute('href', '/work-patches/w1')
  expect(screen.getByRole('link', { name: '运行工作包' })).toHaveAttribute('href', '/work-patches/w1/execute')
  expect(screen.getByRole('button', { name: '执行详情' })).toBeDisabled()
})
