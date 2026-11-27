// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { parentOf, parse, build } from '@ursi/location'
import { DirBrowser } from './dir-browser'
import type { DirListing, ListDirFn } from './types'

afterEach(() => {
  cleanup()
})

/** 用一个位置构造清单：`parent` 交给 `@ursi/location` 推导，测试不自己拼路径。 */
function listingOf(uri: string, names: string[]): DirListing {
  const location = parse(uri)
  return { location, parent: parentOf(location), entries: names.map((name) => ({ name })) }
}

/** 本机位置的简写：`/home/u` 即 `file:///home/u`。 */
const local = (path: string) => build('file', path).uri

function fakeListDir(): ListDirFn & { calls: string[] } {
  const calls: string[] = []
  const fn: ListDirFn = async (target) => {
    calls.push(target)
    // `~` 是服务端解析的本机简写，回包是规范化后的本机位置。
    if (target === '~') return listingOf(local('/home/u'), ['work', 'docs'])
    if (target === local('/home/u/work')) return listingOf(local('/home/u/work'), ['repo'])
    return listingOf(target, [])
  }
  return Object.assign(fn, { calls })
}

function fireKey(element: Element, key: string) {
  fireEvent.keyDown(element, { key })
}

function typeText(element: Element, text: string) {
  fireEvent.change(element, { target: { value: text } })
}

test('挂载即加载初始路径，渲染面包屑与子目录', async () => {
  const listDir = fakeListDir()
  const picked: string[] = []
  const { getByText, container } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={(path) => picked.push(path)} onCancel={() => {}} />,
  )

  await waitFor(() => expect(getByText('work')).toBeTruthy())
  expect(listDir.calls).toEqual(['~'])
  getByText('docs')
  // 面包屑展示规范化后的路径段，底部提示展示完整 URI
  expect(container.textContent).toContain('home')
  expect(container.textContent).toContain('u')
  expect(container.querySelector('.dp-hint')?.textContent).toBe(local('/home/u'))

  getByText('选择此目录').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual([local('/home/u')])
})

test('点击子目录导航，确认提交新路径', async () => {
  const listDir = fakeListDir()
  const picked: string[] = []
  const { getByText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={(path) => picked.push(path)} onCancel={() => {}} />,
  )

  await waitFor(() => expect(getByText('work')).toBeTruthy())
  fireEvent.click(getByText('work'))
  await waitFor(() => expect(getByText('repo')).toBeTruthy())
  expect(listDir.calls).toEqual(['~', local('/home/u/work')])

  getByText('选择此目录').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual([local('/home/u/work')])
})

test('输入路径回车导航，输入过滤词回车进唯一命中', async () => {
  const listDir = fakeListDir()
  const { getByText, getByLabelText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(getByText('work')).toBeTruthy())

  const input = getByLabelText('路径或过滤') as HTMLInputElement
  typeText(input, local('/home/u/work'))
  fireKey(input, 'Enter')
  await waitFor(() => expect(getByText('repo')).toBeTruthy())
  expect(listDir.calls).toEqual(['~', local('/home/u/work')])

  typeText(input, 'repo')
  fireKey(input, 'Enter')
  await waitFor(() =>
    expect(listDir.calls).toEqual(['~', local('/home/u/work'), local('/home/u/work/repo')]),
  )
})

test('Esc 先清过滤，再取消', async () => {
  const listDir = fakeListDir()
  let cancelled = 0
  const { getByText, getByLabelText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => (cancelled += 1)} />,
  )
  await waitFor(() => expect(getByText('work')).toBeTruthy())

  const input = getByLabelText('路径或过滤') as HTMLInputElement
  typeText(input, 'work')
  fireKey(input, 'Escape')
  expect(cancelled).toBe(0)
  expect((input as HTMLInputElement).value).toBe('')

  fireKey(input, 'Escape')
  expect(cancelled).toBe(1)
})

test('错误就地显示，不丢当前列表', async () => {
  const calls: string[] = []
  const listDir: ListDirFn = async (target) => {
    calls.push(target)
    if (target === '/missing') throw new Error('目录不存在：/missing')
    return listingOf(local('/home/u'), ['a'])
  }
  const { getByText, getByLabelText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(getByText('a')).toBeTruthy())

  const input = getByLabelText('路径或过滤') as HTMLInputElement
  typeText(input, '/missing')
  fireKey(input, 'Enter')
  await waitFor(() => expect(getByText('目录不存在：/missing')).toBeTruthy())
  getByText('a')
})

test('并发导航只认最后一次，慢回包被丢弃', async () => {
  const calls: string[] = []
  const resolvers: ((value: DirListing) => void)[] = []
  const listDir: ListDirFn = (target) => {
    calls.push(target)
    return new Promise<DirListing>((resolve) => resolvers.push(resolve))
  }
  const { getByLabelText, getByText, queryByText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(getByText('读取中…')).toBeTruthy())

  const input = getByLabelText('路径或过滤') as HTMLInputElement
  typeText(input, local('/slow'))
  fireKey(input, 'Enter')
  typeText(input, local('/fast'))
  fireKey(input, 'Enter')
  expect(calls).toEqual(['~', local('/slow'), local('/fast')])

  // 先回慢的，后回快的：慢的必须被丢弃。
  await act(async () => {
    resolvers[1](listingOf(local('/slow'), ['stale']))
    resolvers[2](listingOf(local('/fast'), ['fresh']))
    await Promise.resolve()
  })
  await waitFor(() => expect(getByText('fresh')).toBeTruthy())
  expect(queryByText('stale')).toBeNull()
})

test('卸载后在途回包不触发 setState 警告', async () => {
  const resolvers: ((value: DirListing) => void)[] = []
  const listDir: ListDirFn = () => new Promise<DirListing>((resolve) => resolvers.push(resolve))
  const errorSpy = vi.spyOn(console, 'error')
  const { unmount } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  unmount()
  await act(async () => {
    resolvers[0]?.(listingOf(local('/late'), ['x']))
    await Promise.resolve()
  })
  const reactWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('unmounted'))
  expect(reactWarnings).toEqual([])
  errorSpy.mockRestore()
})

test('suggestions 点击导航，note 原样展示', async () => {
  const listDir = fakeListDir()
  const { getByText, container } = render(
    <DirBrowser
      listDir={listDir}
      initialPath="~"
      onSelect={() => {}}
      onCancel={() => {}}
      suggestions={[local('/home/u/work')]}
    />,
  )
  await waitFor(() => expect(getByText('work')).toBeTruthy())
  // suggestion 按钮与列表行都可能含该路径文本，用 title 精确定位快捷项。
  const suggestion = container.querySelector('.dp-suggestions .dp-suggestion') as HTMLButtonElement
  fireEvent.click(suggestion)
  await waitFor(() => expect(getByText('repo')).toBeTruthy())
})

test('加载中禁用确认按钮，避免选中未加载完的目录', async () => {
  let release: ((value: DirListing) => void) | null = null
  const listDir: ListDirFn = () =>
    new Promise<DirListing>((resolve) => {
      release = resolve
    })
  const picked: string[] = []
  const { getByText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={(path) => picked.push(path)} onCancel={() => {}} />,
  )
  const confirm = getByText('选择此目录') as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual([])
  await act(async () => {
    release!(listingOf(local('/home/u'), []))
  })
})

test('远程位置：面包屑第一级显示设备名，确认提交 ssh URI', async () => {
  const listDir = fakeListDir()
  const picked: string[] = []
  const { getByText, container } = render(
    <DirBrowser
      listDir={listDir}
      initialPath="ssh://nm105/srv/proj"
      onSelect={(uri) => picked.push(uri)}
      onCancel={() => {}}
    />,
  )
  await waitFor(() => expect(getByText('nm105')).toBeTruthy())
  // 第一级是设备名，其后是设备内路径段
  const crumbs = Array.from(container.querySelectorAll('.dp-crumb')).map((node) => node.textContent)
  expect(crumbs).toEqual(['nm105', 'srv', 'proj'])
  expect(container.querySelector('.dp-hint')?.textContent).toBe('ssh://nm105/srv/proj')

  getByText('选择此目录').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual(['ssh://nm105/srv/proj'])
})

test('远程位置：进入子目录与上一级都保留设备', async () => {
  const calls: string[] = []
  const listDir: ListDirFn = async (target) => {
    calls.push(target)
    if (target === 'ssh://nm105/srv') return listingOf('ssh://nm105/srv', ['proj'])
    return listingOf(target, [])
  }
  const { getByText, getByLabelText } = render(
    <DirBrowser listDir={listDir} initialPath="ssh://nm105/srv" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(getByText('proj')).toBeTruthy())

  fireEvent.click(getByText('proj'))
  await waitFor(() => expect((getByLabelText('上一级') as HTMLButtonElement).disabled).toBe(false))
  expect(calls).toEqual(['ssh://nm105/srv', 'ssh://nm105/srv/proj'])

  fireEvent.click(getByLabelText('上一级') as HTMLButtonElement)
  await waitFor(() => expect(calls).toEqual(['ssh://nm105/srv', 'ssh://nm105/srv/proj', 'ssh://nm105/srv']))
})

test('~ 与 / 在远程设备上落到设备根，在本机落到服务端主目录', async () => {
  const calls: string[] = []
  const listDir: ListDirFn = async (target) => {
    calls.push(target)
    return listingOf(target.includes('://') ? target : local('/home/u'), [])
  }
  const { getByLabelText, rerender } = render(
    <DirBrowser listDir={listDir} initialPath="ssh://nm105/srv" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect((getByLabelText('主目录') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(getByLabelText('主目录') as HTMLButtonElement)
  await waitFor(() => expect(calls).toEqual(['ssh://nm105/srv', 'ssh://nm105/']))

  rerender(
    <DirBrowser key="local" listDir={listDir} initialPath="file:///srv" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(calls).toContain('file:///srv'))
  fireEvent.click(getByLabelText('主目录') as HTMLButtonElement)
  // 本机的 `~` 原样透传，由服务端展开
  await waitFor(() => expect(calls[calls.length - 1]).toBe('~'))
})

test('devices 注入后出现设备下拉，本机固定第一项，切换跳设备根', async () => {
  const calls: string[] = []
  const listDir: ListDirFn = async (target) => {
    calls.push(target)
    return listingOf(target.includes('://') ? target : local('/home/u'), [])
  }
  const { getByLabelText, container } = render(
    <DirBrowser
      listDir={listDir}
      initialPath="~"
      onSelect={() => {}}
      onCancel={() => {}}
      devices={[{ device: 'nm105', label: '工作台 105' }, { device: 'nas' }]}
    />,
  )
  await waitFor(() => expect((getByLabelText('主目录') as HTMLButtonElement).disabled).toBe(false))

  const select = getByLabelText('设备') as HTMLSelectElement
  const options = Array.from(select.options).map((option) => [option.value, option.textContent])
  expect(options).toEqual([
    ['', '本机'],
    ['nm105', '工作台 105'],
    ['nas', 'nas'],
  ])
  expect(container.querySelector('.dp-crumbs .dp-device')).toBe(select)
  // 加载完成前下拉停在「本机」
  expect(select.value).toBe('')

  fireEvent.change(select, { target: { value: 'nm105' } })
  await waitFor(() => expect(calls[calls.length - 1]).toBe('ssh://nm105/'))
})

test('不传 devices 时不渲染设备下拉', async () => {
  const listDir = fakeListDir()
  const { container } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(container.querySelector('.dp-device')).toBeNull())
})
