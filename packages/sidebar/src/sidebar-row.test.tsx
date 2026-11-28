// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SidebarRow } from './sidebar-row'

afterEach(() => cleanup())

test('根元素是 button，带 sb-row 类；active 加 is-active', () => {
  const { container, rerender } = render(<SidebarRow label="a" />)
  const root = container.querySelector('button.sb-row')
  expect(root).not.toBeNull()
  expect(root!.classList.contains('is-active')).toBe(false)
  rerender(<SidebarRow label="a" active />)
  expect(container.querySelector('button.sb-row.is-active')).not.toBeNull()
})

test('调用方的 className 拼在后面，业务状态类不丢', () => {
  const { container } = render(<SidebarRow label="a" className="project-item drop-over" />)
  const root = container.querySelector('button')!
  expect(root.className).toBe('sb-row sb-row--inline project-item drop-over')
})

test('label 与 meta 各自一个 span；meta 为空时不渲染', () => {
  const { container, rerender } = render(<SidebarRow label="名" meta="附加" />)
  expect(container.querySelector('.sb-row-label')!.textContent).toBe('名')
  expect(container.querySelector('.sb-row-meta')!.textContent).toBe('附加')
  rerender(<SidebarRow label="名" />)
  expect(container.querySelector('.sb-row-meta')).toBeNull()
})

test('layout 决定修饰类：默认 inline，stack 显式指定', () => {
  const { container, rerender } = render(<SidebarRow label="a" />)
  expect(container.querySelector('.sb-row--inline')).not.toBeNull()
  rerender(<SidebarRow label="a" layout="stack" />)
  expect(container.querySelector('.sb-row--stack')).not.toBeNull()
})

test('leading 渲染在 label 之前，trailing 渲染在 label 内部，children 在 meta 之后', () => {
  const { container } = render(
    <SidebarRow label="名" meta="附" leading={<i className="lead" />} trailing={<b className="tail" />}>
      <span className="child" />
    </SidebarRow>,
  )
  const root = container.querySelector('button')!
  const order = Array.from(root.children).map((node) => node.className)
  expect(order).toEqual(['sb-row-leading', 'sb-row-label', 'sb-row-meta', 'child'])
  expect(root.querySelector('.sb-row-label .tail')).not.toBeNull()
})

test('title、aria-current、data-* 原样挂到根元素', () => {
  const { container } = render(<SidebarRow label="a" title="提示" ariaCurrent="page" data-project-id="p1" />)
  const root = container.querySelector('button')!
  expect(root.title).toBe('提示')
  expect(root.getAttribute('aria-current')).toBe('page')
  expect(root.dataset.projectId).toBe('p1')
})

test('onClick、onContextMenu 原样触发；rowRef 拿到根元素', () => {
  const onClick = vi.fn()
  const onContextMenu = vi.fn()
  const rowRef = vi.fn()
  const { container } = render(<SidebarRow label="a" onClick={onClick} onContextMenu={onContextMenu} rowRef={rowRef} />)
  const root = container.querySelector('button')!
  expect(rowRef).toHaveBeenCalledWith(root)
  fireEvent.click(root)
  fireEvent.contextMenu(root)
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(onContextMenu).toHaveBeenCalledTimes(1)
})
