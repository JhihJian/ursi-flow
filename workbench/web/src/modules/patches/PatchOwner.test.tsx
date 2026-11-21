import { expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { PatchOwner } from './PatchOwner'

it('生成包解除关联后仍可从来源打开原运行', async () => {
  render(<MemoryRouter><PatchOwner onSaved={() => {}} patch={{ id: 'p1', directoryId: 'd1', name: '周报', workItemId: null,
    provenance: { runId: 'original-run', workItemId: 'original-item', workItemTitle: '生成时的标题', revision: 1, scriptSha256: 'abc', resources: [] },
  }} /></MemoryRouter>)
  expect(screen.getByText('未关联')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '生成来源' }))
  const source = within(screen.getByRole('dialog', { name: '生成来源' }))
  expect(source.getByText(/生成时的标题/)).toBeInTheDocument()
  expect(source.getByRole('link', { name: '查看生成记录' })).toHaveAttribute('href', '/work-patch-generation-runs/original-run')
})
