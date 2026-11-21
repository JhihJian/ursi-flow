import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setToken } from '@/shared/http/session'
import type { McpSettings } from '@/shared/api/mcp'
import { SettingsPanel } from './SettingsPanel'

const initial = { allowedTools: ['fixture'], githubToolsets: [], githubReadOnly: true }
function Panel() {
  const [settings, saved] = useState<McpSettings>(initial)
  return <SettingsPanel server={{ id: 's', name: 'fixture', url: 'https://api.githubcopilot.com/mcp/' }} settings={settings} saved={saved} />
}
afterEach(() => { cleanup(); setToken(''); vi.unstubAllGlobals() })
it('工具集按行启停；空选择使用默认值，保存不改变工具调用授权', async () => {
  setToken('fixture-only')
  const writes: McpSettings[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const value = JSON.parse(init.body); writes.push(value); return Response.json(value)
  }))
  render(<Panel />)
  await userEvent.type(screen.getByLabelText('筛选工具集'), 'repos')
  const toggle = () => screen.getByRole('switch', { name: '启用工具集 repos' })
  await userEvent.click(toggle()); await waitFor(() => expect(toggle()).toBeChecked())
  await userEvent.click(toggle()); await screen.findByText('使用 GitHub 默认工具集')
  expect(writes).toEqual([{ ...initial, githubToolsets: ['repos'] }, initial])
})
