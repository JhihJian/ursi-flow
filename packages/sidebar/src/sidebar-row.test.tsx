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
  expect(container.querySelector('button')!.className).toBe('sb-row project-item drop-over')
})

test('结构固定：leading | main（label / meta / children）| trailing；空槽不渲染', () => {
  const { container } = render(
    <SidebarRow label="名" meta="附加" leading={<i className="lead" />} trailing={<b className="tail" />}>
      <span className="child" />
    </SidebarRow>,
  )
  const root = container.querySelector('button')!
  expect(Array.from(root.children).map((n) => n.className)).toEqual(['sb-leading', 'sb-main', 'sb-trailing'])
  expect(Array.from(root.querySelector('.sb-main')!.children).map((n) => n.className)).toEqual(['sb-label', 'sb-meta', 'child'])
  expect(root.querySelector('.sb-trailing .tail')).not.toBeNull()
})

test('没有 meta 就是单行：不渲染 meta 节点', () => {
  const { container } = render(<SidebarRow label="名" />)
  expect(container.querySelector('.sb-meta')).toBeNull()
  expect(container.querySelector('.sb-main')!.childElementCount).toBe(1)
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

test('as="div" 时根元素是 div，用于行里要嵌套按钮的场景；点击与 ref 照常', () => {
  const onClick = vi.fn()
  const { container } = render(<SidebarRow as="div" label="a" onClick={onClick} />)
  const root = container.querySelector('div.sb-row')
  expect(root).not.toBeNull()
  expect(root!.hasAttribute('type')).toBe(false)
  fireEvent.click(root!)
  expect(onClick).toHaveBeenCalledTimes(1)
})
