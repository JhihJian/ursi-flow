import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Directory } from './api'
import { ConfigEditor } from './ConfigEditor'
import { memoryDirectory } from './config/test-utils'

vi.mock('./Explorer', () => ({
  Explorer: ({ root, initialPath }: { root?: string; initialPath?: string }) =>
    <div data-testid="explorer" data-root={root} data-initial={initialPath} />,
}))

const prompt = '# 系统提示词\n\n保持简洁。'
const mcp = '{\n  "mcpServers": {}\n}\n'

/** 编辑器用路由跳转做未保存拦截，测试也必须跑在数据路由里。 */
function renderEditor(directory: Directory) {
  const router = createMemoryRouter([{ path: '/', element: <ConfigEditor directory={directory} /> }])
  return render(<RouterProvider router={router} />)
}

function fixture() {
  return memoryDirectory(
    {
      'AGENTS.md': prompt,
      'mcp.json': mcp,
      'skills/review/SKILL.md': '---\nname: review\n---\n',
      'skills/review/templates/checklist.md': '- [ ] 阅读',
    },
    ['skills', 'skills/review/templates'],
  )
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('配置补丁编辑器', () => {
  it('默认显示系统提示词，读取 AGENTS.md 后显式保存覆盖写入', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    const editor = await screen.findByLabelText('AGENTS.md 内容') as HTMLTextAreaElement
    expect(editor.value).toBe(prompt)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, '# 新提示词')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('已保存')
    expect(directory.writes).toEqual([{ path: 'AGENTS.md', content: '# 新提示词', replace: true }])
  })

  it('切换到 MCP 后非法 JSON 只提示不保存，改好后再保存覆盖原文', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    await user.click(screen.getByRole('tab', { name: 'MCP' }))
    const editor = screen.getByLabelText('mcp.json 内容') as HTMLTextAreaElement
    await waitFor(() => expect(editor.value).toBe(mcp))

    fireEvent.change(editor, { target: { value: '{"mcpServers":' } })
    expect(screen.getByRole('alert').textContent).toContain('JSON')
    expect(editor.value).toBe('{"mcpServers":')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(directory.writes).toEqual([])

    fireEvent.change(editor, { target: { value: '{"mcpServers":{"demo":{"command":"npx"}}}' } })
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('已保存')
    expect(directory.writes).toEqual([
      { path: 'mcp.json', content: '{"mcpServers":{"demo":{"command":"npx"}}}', replace: true },
    ])
  })

  it('Skills 列表来自 skills/ 目录，选中后交给 Explorer 维护入口文件', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    const skillsTab = await screen.findByRole('tab', { name: /Skills/ })
    await waitFor(() => expect(skillsTab.textContent).toContain('1'))
    await user.click(skillsTab)

    await user.click(await screen.findByTestId('skill-item-review'))
    const explorer = screen.getByTestId('explorer')
    expect(explorer.getAttribute('data-root')).toBe('skills/review')
    expect(explorer.getAttribute('data-initial')).toBe('skills/review/SKILL.md')
  })

  it('新增 Skill 创建目录和 SKILL.md，并选中新的目录', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    await user.click(await screen.findByRole('tab', { name: /Skills/ }))
    await user.type(screen.getByLabelText('新建 Skill 名称'), 'code-review')
    await user.click(screen.getByTestId('skill-create'))

    await screen.findByTestId('skill-item-code-review')
    expect(directory.created).toEqual(['skills/code-review'])
    expect(directory.writes).toEqual([
      { path: 'skills/code-review/SKILL.md', content: expect.stringContaining('name: code-review'), replace: false },
    ])
    await waitFor(() => expect(screen.getByTestId('explorer').getAttribute('data-root')).toBe('skills/code-review'))
    expect(screen.getByTestId('explorer').getAttribute('data-initial')).toBe('skills/code-review/SKILL.md')
  })

  it('重名与非法 Skill 名称只提示，不写入目录', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    await user.click(await screen.findByRole('tab', { name: /Skills/ }))
    await user.type(screen.getByLabelText('新建 Skill 名称'), 'review')
    await user.click(screen.getByTestId('skill-create'))

    expect((await screen.findByRole('alert')).textContent).toContain('同名')
    fireEvent.change(screen.getByLabelText('新建 Skill 名称'), { target: { value: 'a/b' } })
    await user.click(screen.getByTestId('skill-create'))
    expect(screen.getByRole('alert').textContent).toContain('小写字母')
    expect(directory.created).toEqual([])
    expect(directory.writes).toEqual([])
  })

  it('SKILL.md 写入失败时保留目录，不会删除其他编辑者的文件', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    directory.write = async () => { throw new Error('磁盘写入失败') }
    renderEditor(directory)

    await user.click(await screen.findByRole('tab', { name: /Skills/ }))
    await user.type(screen.getByLabelText('新建 Skill 名称'), 'draft')
    await user.click(screen.getByTestId('skill-create'))

    expect((await screen.findByRole('alert')).textContent).toContain('磁盘写入失败')
    expect(directory.created).toEqual(['skills/draft'])
    expect(directory.removed).toEqual([])
  })

  it('切换标签保留未保存草稿', async () => {
    const user = userEvent.setup()
    const directory = fixture()
    renderEditor(directory)

    const editor = await screen.findByLabelText('AGENTS.md 内容')
    fireEvent.change(editor, { target: { value: '# 草稿' } })
    await user.click(screen.getByRole('tab', { name: 'MCP' }))
    await user.click(screen.getByRole('tab', { name: '系统提示词' }))

    expect((screen.getByLabelText('AGENTS.md 内容') as HTMLTextAreaElement).value).toBe('# 草稿')
    expect(directory.writes).toEqual([])
  })
})
