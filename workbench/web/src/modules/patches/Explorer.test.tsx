import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, RouterProvider } from 'react-router'

import { Explorer } from './Explorer'
import { FeedbackHost, mountExplorer, createMemoryDirectory, makeFile, resetFeedback } from './explorer/test-utils'

const originalMatchMedia = window.matchMedia

beforeEach(() => { resetFeedback() })

afterEach(() => {
  cleanup()
  resetFeedback()
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
})

/** 窄屏由媒体查询表达，容器宽度未知时回退到它。 */
function setNarrow(narrow = true) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  window.dispatchEvent(new Event('resize'))
}

function row(path: string): HTMLElement {
  const found = screen.getAllByTestId('explorer-row').find(element => element.dataset.path === path)
  if (!found) throw new Error(`没有找到文件行 ${path}`)
  return found
}

function calls(directory: ReturnType<typeof createMemoryDirectory>, method: string) {
  return directory.calls.filter(call => call.method === method).map(call => call.args)
}

describe('文件树与编辑', () => {
  it('载入目录后打开首个 Markdown，编辑后保存写入原始文本并标记未保存', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': '# 说明', 'docs/guide.md': '# 指南', 'notes.txt': 'plain' } })
    const { user } = mountExplorer({ directory: memory.directory })

    const editor = await screen.findByLabelText('AGENTS.md 内容')
    expect(editor).toHaveValue('# 说明')
    expect(screen.getByTestId('explorer-tab')).toHaveAttribute('data-path', 'AGENTS.md')
    expect(screen.getByText('docs', { selector: 'span' })).toBeVisible()

    await user.clear(editor)
    await user.type(editor, '# 新说明')
    expect(screen.getByLabelText('未保存')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(calls(memory, 'write')).toEqual([['AGENTS.md', '# 新说明', true]]) })
    await waitFor(() => { expect(screen.queryByLabelText('未保存')).toBeNull() })
    expect(await memory.text('AGENTS.md')).toBe('# 新说明')
  })

  it('展开目录切换文件，关闭标签后不再保留读取结果', async () => {
    const memory = createMemoryDirectory({ files: { 'docs/guide.md': '# 指南', 'docs/more/ref.md': '# 参考' } })
    const { user } = mountExplorer({ directory: memory.directory })

    await screen.findByLabelText('docs/guide.md 内容')
    // 自动打开的文件已展开 docs，直接展开更深一层的 more。
    await user.click(screen.getByRole('button', { name: 'more' }))
    await user.click(within(row('docs/more/ref.md')).getByRole('button', { name: 'ref.md' }))

    expect(await screen.findByLabelText('docs/more/ref.md 内容')).toHaveValue('# 参考')
    expect(screen.getAllByTestId('explorer-tab')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: '关闭 guide.md' }))
    expect(screen.getAllByTestId('explorer-tab')).toHaveLength(1)
    expect(screen.getByTestId('explorer-tab')).toHaveAttribute('data-path', 'docs/more/ref.md')
  })

  it('Markdown 可在编辑、分栏与预览之间切换，预览解析标题', async () => {
    const memory = createMemoryDirectory({ files: { 'README.md': '# 标题\n\n正文段落' } })
    const { user } = mountExplorer({ directory: memory.directory })

    await screen.findByLabelText('README.md 内容')
    await user.click(screen.getByTestId('md-view-preview'))

    expect(await screen.findByRole('heading', { name: '标题' })).toBeVisible()
    expect(screen.getByText('正文段落')).toBeVisible()
    expect(screen.queryByLabelText('README.md 内容')).toBeNull()

    await user.click(screen.getByTestId('md-view-edit'))
    expect(await screen.findByLabelText('README.md 内容')).toBeVisible()
  })
})

describe('折叠与布局', () => {
  it('折叠后只留展开入口，重新展开恢复文件树', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    await user.click(screen.getByRole('button', { name: '折叠文件面板' }))
    expect(screen.queryByTestId('explorer-tree')).toBeNull()
    expect(screen.getByRole('button', { name: '展开文件面板' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '展开文件面板' }))
    expect(await screen.findByTestId('explorer-tree')).toBeVisible()
  })
})

describe('新建、重命名与删除', () => {
  it('新建文件先补齐父目录再只新建写入，并直接打开', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    await user.click(screen.getByRole('button', { name: '新建文件' }))
    await user.type(screen.getByLabelText('新文件名称'), 'docs/todo.md{Enter}')

    await waitFor(() => { expect(calls(memory, 'mkdir')).toEqual([['docs']]) })
    expect(calls(memory, 'write')).toEqual([['docs/todo.md', '', false]])
    expect(await screen.findByLabelText('docs/todo.md 内容')).toHaveValue('')
  })

  it('新建目录后树中可见，重命名文件同步标签路径', async () => {
    const memory = createMemoryDirectory({ files: { 'docs/guide.md': '# 指南' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('docs/guide.md 内容')

    await user.click(screen.getByRole('button', { name: '新建文件夹' }))
    await user.type(screen.getByLabelText('新目录名称'), 'assets{Enter}')
    await waitFor(() => { expect(calls(memory, 'mkdir')).toEqual([['assets']]) })

    await user.click(screen.getByRole('button', { name: '重命名 guide.md' }))
    const input = screen.getByLabelText('重命名')
    await user.clear(input)
    await user.type(input, 'handbook.md{Enter}')

    await waitFor(() => { expect(calls(memory, 'move')).toEqual([['docs/guide.md', 'docs/handbook.md']]) })
    await waitFor(() => { expect(row('docs/handbook.md')).toBeVisible() })
    expect(await screen.findByLabelText('docs/handbook.md 内容')).toBeVisible()
    expect(screen.getByTestId('explorer-tab')).toHaveAttribute('data-path', 'docs/handbook.md')
  })

  it('删除前确认，确认后调用删除并从标签中移除', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a', 'tmp/old.md': 'b' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    await user.click(screen.getByRole('button', { name: 'AGENTS.md' }))
    await user.click(screen.getByRole('button', { name: '删除 AGENTS.md' }))
    const dialog = await screen.findByRole('group', { name: '删除文件？' })
    await user.click(within(dialog).getByRole('button', { name: '删除' }))

    await waitFor(() => { expect(calls(memory, 'remove')).toEqual([['AGENTS.md']]) })
    await waitFor(() => { expect(screen.queryByTestId('explorer-tab')).toBeNull() })
    expect(memory.files.has('AGENTS.md')).toBe(false)
  })
})

describe('移动与受保护位置', () => {
  it('重命名时输入路径可移动到新目录，并同步标签与树', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a', 'docs/guide.md': '# 指南' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    await user.click(screen.getByRole('button', { name: 'docs' }))
    await user.click(within(row('docs/guide.md')).getByRole('button', { name: 'guide.md' }))
    await user.click(screen.getByRole('button', { name: '重命名 guide.md' }))
    const input = screen.getByLabelText('重命名')
    await user.clear(input)
    await user.type(input, 'moved/guide.md{Enter}')

    await waitFor(() => { expect(calls(memory, 'mkdir')).toEqual([['moved']]) })
    expect(calls(memory, 'move')).toEqual([['docs/guide.md', 'moved/guide.md']])
    await waitFor(() => { expect(row('moved/guide.md')).toBeVisible() })
    expect(screen.getAllByTestId('explorer-tab').map(tab => tab.dataset.path)).toContain('moved/guide.md')
  })

})

describe('上传与二进制', () => {
  it('上传文件写入根目录，导入目录去掉顶层目录名并保留相对路径', async () => {
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a' } })
    mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    fireEvent.change(screen.getByTestId('explorer-upload-input'), { target: { files: [makeFile('upload.txt', 'body')] } })
    await waitFor(() => { expect(calls(memory, 'write')).toEqual([['upload.txt', '<blob>', false]]) })

    fireEvent.change(screen.getByTestId('explorer-import-input'), {
      target: { files: [makeFile('deep.md', 'deep', 'pkg/skills/deep.md'), makeFile('top.md', 'top', 'pkg/top.md')] },
    })

    await waitFor(() => {
      expect(calls(memory, 'write')).toContainEqual(['skills/deep.md', '<blob>', false])
      expect(calls(memory, 'write')).toContainEqual(['top.md', '<blob>', false])
    })
    expect(calls(memory, 'mkdir')).toEqual([['skills']])
    expect(await memory.text('skills/deep.md')).toBe('deep')
  })

  it('二进制文件只提供下载，不渲染文本编辑器也不回写', async () => {
    const binary = new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a)], { type: 'image/png' })
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a', 'assets/logo.png': binary } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('AGENTS.md 内容')

    await user.click(screen.getByRole('button', { name: 'assets' }))
    await user.click(within(row('assets/logo.png')).getByRole('button', { name: 'logo.png' }))

    expect(await screen.findByRole('button', { name: /下载文件/ })).toBeVisible()
    expect(screen.queryByLabelText('assets/logo.png 内容')).toBeNull()
    expect(calls(memory, 'write')).toEqual([])
  })
})

describe('离开路由保护', () => {
  it('有未保存修改时切换包先确认，取消后停留在原页面', async () => {
    const memory = createMemoryDirectory({ files: { 'a.md': 'A' } })
    const user = userEvent.setup()
    const router = createMemoryRouter([
      {
        path: '/',
        element: <><Explorer directory={memory.directory} /><FeedbackHost /><Link to="/other">离开</Link></>,
      },
      { path: '/other', element: <p>另一个包</p> },
    ], { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)

    const editor = await screen.findByLabelText('a.md 内容')
    await user.type(editor, ' 编辑')
    await user.click(screen.getByRole('link', { name: '离开' }))

    const dialog = await screen.findByRole('group', { name: '放弃未保存的更改？' })
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(router.state.location.pathname).toBe('/')

    await user.click(screen.getByRole('link', { name: '离开' }))
    const again = await screen.findByRole('group', { name: '放弃未保存的更改？' })
    await user.click(within(again).getByRole('button', { name: '放弃更改' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/other') })
  })
})

describe('上下文操作', () => {
  it('右键文件行打开菜单，可从菜单重命名', async () => {
    const memory = createMemoryDirectory({ files: { 'a.md': 'A', 'b.md': 'B' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await screen.findByLabelText('a.md 内容')

    fireEvent.contextMenu(row('b.md'))
    const menu = await screen.findByRole('menu', { name: '文件操作' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.dataset.action)).toEqual([
      'newFile', 'newFolder', 'uploadFile', 'importDir', 'rename', 'copyPath', 'download', 'delete',
    ])
    await user.click(within(menu).getByRole('menuitem', { name: /^重命名/ }))
    expect(await screen.findByLabelText('重命名')).toHaveValue('b.md')
    await user.keyboard('{Escape}')
    expect(screen.queryByLabelText('重命名')).toBeNull()
  })

  it('窄屏每行提供更多菜单，可在此新建文件', async () => {
    setNarrow()
    const memory = createMemoryDirectory({ files: { 'a.md': 'A' } })
    const { user } = mountExplorer({ directory: memory.directory })
    await waitFor(() => { expect(screen.getByTestId('patch-explorer')).toHaveAttribute('data-compact', 'true') })

    await user.click(screen.getByRole('button', { name: 'a.md 的更多操作' }))
    const menu = await screen.findByRole('menu', { name: '文件操作' })
    await user.click(within(menu).getByRole('menuitem', { name: '新建文件' }))
    expect(await screen.findByLabelText('新文件名称')).toBeVisible()
  })
})

describe('未保存切换保护', () => {
  it('切换到其他文件前询问，放弃后内容回退到已保存版本', async () => {
    const memory = createMemoryDirectory({ files: { 'a.md': 'A', 'b.md': 'B' } })
    const { user } = mountExplorer({ directory: memory.directory })
    const editor = await screen.findByLabelText('a.md 内容')

    await user.clear(editor)
    await user.type(editor, 'A 修改')
    await user.click(within(row('b.md')).getByRole('button', { name: 'b.md' }))

    const dialog = await screen.findByRole('dialog', { name: '有未保存的更改' })
    await user.click(within(dialog).getByRole('button', { name: '放弃更改' }))

    expect(await screen.findByLabelText('b.md 内容')).toHaveValue('B')
    expect(calls(memory, 'write')).toEqual([])
    await user.click(screen.getAllByTestId('explorer-tab').find(tab => tab.dataset.path === 'a.md')!)
    expect(await screen.findByLabelText('a.md 内容')).toHaveValue('A')
  })

  it('选择保存并继续时先写入再切换', async () => {
    const memory = createMemoryDirectory({ files: { 'a.md': 'A', 'b.md': 'B' } })
    const { user } = mountExplorer({ directory: memory.directory })
    const editor = await screen.findByLabelText('a.md 内容')

    await user.clear(editor)
    await user.type(editor, 'A2')
    await user.click(within(row('b.md')).getByRole('button', { name: 'b.md' }))

    const dialog = await screen.findByRole('dialog', { name: '有未保存的更改' })
    await user.click(within(dialog).getByRole('button', { name: '保存并继续' }))

    await waitFor(() => { expect(calls(memory, 'write')).toEqual([['a.md', 'A2', true]]) })
    expect(await screen.findByLabelText('b.md 内容')).toHaveValue('B')
  })
})

describe('窄屏分步与范围限定', () => {
  it('窄屏先显示列表，打开文件进入编辑，返回时按未保存状态询问', async () => {
    setNarrow()
    const memory = createMemoryDirectory({ files: { 'AGENTS.md': 'a', 'docs/guide.md': 'g' } })
    const { user } = mountExplorer({ directory: memory.directory })

    await waitFor(() => { expect(screen.getByTestId('patch-explorer')).toHaveAttribute('data-compact', 'true') })
    expect(screen.queryByLabelText('AGENTS.md 内容')).toBeNull()

    await user.click(within(row('AGENTS.md')).getByRole('button', { name: 'AGENTS.md' }))
    const editor = await screen.findByLabelText('AGENTS.md 内容')
    expect(screen.getByRole('button', { name: '返回' })).toBeVisible()

    await user.type(editor, ' 追加')
    await user.click(screen.getByRole('button', { name: '返回' }))
    const dialog = await screen.findByRole('dialog', { name: '有未保存的更改' })
    await user.click(within(dialog).getByRole('button', { name: '放弃更改' }))

    await waitFor(() => { expect(screen.queryByLabelText('AGENTS.md 内容')).toBeNull() })
    expect(row('AGENTS.md')).toBeVisible()
  })

  it('root 只限制显示范围，读取仍使用包根相对路径', async () => {
    const memory = createMemoryDirectory({
      files: { 'AGENTS.md': 'a', 'skills/review.md': 'r', 'skills/tools/lint.md': 'l' },
    })
    const { user } = mountExplorer({ directory: memory.directory, root: 'skills', initialPath: 'skills/review.md' })

    expect(await screen.findByLabelText('skills/review.md 内容')).toBeVisible()
    await waitFor(() => { expect(screen.getAllByTestId('explorer-row').length).toBeGreaterThan(0) })
    expect(screen.queryByText('AGENTS.md')).toBeNull()
    expect(row('skills/review.md')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'tools' }))
    await user.click(within(row('skills/tools/lint.md')).getByRole('button', { name: 'lint.md' }))
    expect(await screen.findByLabelText('skills/tools/lint.md 内容')).toBeVisible()
    expect(calls(memory, 'read')).toContainEqual(['skills/tools/lint.md'])
  })
})
