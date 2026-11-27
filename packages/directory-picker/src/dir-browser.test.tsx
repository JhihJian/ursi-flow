// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DirBrowser } from './dir-browser'
import type { DirListing, ListDirFn } from './types'

afterEach(() => {
  cleanup()
})

function listingOf(path: string, names: string[]): DirListing {
  return {
    path,
    parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
    entries: names.map((name) => ({ name })),
  }
}

function fakeListDir(): ListDirFn & { calls: string[] } {
  const calls: string[] = []
  const fn: ListDirFn = async (target) => {
    calls.push(target)
    if (target === '~') return listingOf('/home/u', ['work', 'docs'])
    if (target === '/home/u/work') return listingOf('/home/u/work', ['repo'])
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
  // 面包屑展示规范化后的路径
  expect(container.textContent).toContain('/home/u')

  getByText('选择此目录').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual(['/home/u'])
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
  expect(listDir.calls).toEqual(['~', '/home/u/work'])

  getByText('选择此目录').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(picked).toEqual(['/home/u/work'])
})

test('输入路径回车导航，输入过滤词回车进唯一命中', async () => {
  const listDir = fakeListDir()
  const { getByText, getByLabelText } = render(
    <DirBrowser listDir={listDir} initialPath="~" onSelect={() => {}} onCancel={() => {}} />,
  )
  await waitFor(() => expect(getByText('work')).toBeTruthy())

  const input = getByLabelText('路径或过滤') as HTMLInputElement
  typeText(input, '/home/u/work')
  fireKey(input, 'Enter')
  await waitFor(() => expect(getByText('repo')).toBeTruthy())
  expect(listDir.calls).toEqual(['~', '/home/u/work'])

  typeText(input, 'repo')
  fireKey(input, 'Enter')
  await waitFor(() => expect(listDir.calls).toEqual(['~', '/home/u/work', '/home/u/work/repo']))
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
    return listingOf('~', ['a'])
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
  typeText(input, '/slow')
  fireKey(input, 'Enter')
  typeText(input, '/fast')
  fireKey(input, 'Enter')
  expect(calls).toEqual(['~', '/slow', '/fast'])

  // 先回慢的，后回快的：慢的必须被丢弃。
  await act(async () => {
    resolvers[1](listingOf('/slow', ['stale']))
    resolvers[2](listingOf('/fast', ['fresh']))
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
    resolvers[0]?.(listingOf('/late', ['x']))
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
      suggestions={['/home/u/work']}
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
    release!(listingOf('~', []))
  })
})
