// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SidebarGroup } from './sidebar-group'
import { SidebarRow } from './sidebar-row'

afterEach(() => cleanup())

/** group 根元素与它的直接父行。 */
function groupOf(container: HTMLElement) {
  const group = container.querySelector<HTMLElement>('.sb-group')!
  return { group, parent: group.querySelector<HTMLElement>(':scope > .sb-row')! }
}

test('父行是 div（不与 chevron 的 button 嵌套），带 chevron；open 时渲染子级，关着时不渲染', () => {
  const { container, rerender } = render(
    <SidebarGroup open label="父" onToggle={() => {}}>
      <SidebarRow label="子" />
    </SidebarGroup>,
  )
  const group = container.querySelector('.sb-group')!
  expect(group.classList.contains('is-open')).toBe(true)
  const parent = group.querySelector(':scope > .sb-row')
  expect(parent!.tagName).toBe('DIV')
  expect(group.querySelector('button button')).toBeNull()
  expect(group.querySelector('.sb-group-children .sb-row')!.textContent).toBe('子')
  const chevron = group.querySelector<HTMLButtonElement>('.sb-chevron')!
  expect(chevron.getAttribute('aria-expanded')).toBe('true')
  expect(chevron.classList.contains('is-open')).toBe(true)
  rerender(
    <SidebarGroup open={false} label="父" onToggle={() => {}}>
      <SidebarRow label="子" />
    </SidebarGroup>,
  )
  expect(container.querySelector('.sb-group-children')).toBeNull()
  expect(container.querySelector('.sb-chevron')!.getAttribute('aria-expanded')).toBe('false')
})

test('点父行触发 onToggle 和 onClick；点 chevron 只触发 onToggle（不冒泡到父行）', () => {
  const onToggle = vi.fn()
  const onClick = vi.fn()
  const { container } = render(
    <SidebarGroup open label="父" onToggle={onToggle} onClick={onClick}>
      <SidebarRow label="子" />
    </SidebarGroup>,
  )
  const { parent, group } = groupOf(container)
  fireEvent.click(parent)
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(onClick).toHaveBeenCalledTimes(1)
  fireEvent.click(group.querySelector('.sb-chevron')!)
  expect(onToggle).toHaveBeenCalledTimes(2)
  expect(onClick).toHaveBeenCalledTimes(1)
})

test('active、title、onContextMenu、className 透传到父行', () => {
  const onContextMenu = vi.fn()
  const { container } = render(
    <SidebarGroup open active title="提示" className="my-row" label="父" onToggle={() => {}} onContextMenu={onContextMenu} />,
  )
  const { parent } = groupOf(container)
  expect(parent.classList.contains('is-active')).toBe(true)
  expect(parent.classList.contains('my-row')).toBe(true)
  expect(parent.title).toBe('提示')
  fireEvent.contextMenu(parent)
  expect(onContextMenu).toHaveBeenCalledTimes(1)
})

test('嵌套深度自动 +1 写进 CSS 变量，调用方不用手传；显式 depth 可覆盖', () => {
  const { container } = render(
    <SidebarGroup open label="外" onToggle={() => {}}>
      <SidebarGroup open label="内" onToggle={() => {}}>
        <SidebarRow label="叶" />
      </SidebarGroup>
    </SidebarGroup>,
  )
  const groups = container.querySelectorAll<HTMLElement>('.sb-group')
  expect(groups[0].style.getPropertyValue('--sb-depth')).toBe('0')
  expect(groups[1].style.getPropertyValue('--sb-depth')).toBe('1')
  expect(container.querySelectorAll('.sb-row').length).toBe(3)
  cleanup()
  const override = render(
    <SidebarGroup open label="外" onToggle={() => {}} depth={5}>
      <SidebarGroup open label="内" onToggle={() => {}} />
    </SidebarGroup>,
  )
  const g2 = override.container.querySelectorAll<HTMLElement>('.sb-group')
  expect(g2[0].style.getPropertyValue('--sb-depth')).toBe('5')
  expect(g2[1].style.getPropertyValue('--sb-depth')).toBe('6')
})

test('子级里的 SidebarRow 点击不触发父行的 onToggle', () => {
  const onToggle = vi.fn()
  const onChild = vi.fn()
  const { container } = render(
    <SidebarGroup open label="父" onToggle={onToggle}>
      <SidebarRow label="子" onClick={onChild} />
    </SidebarGroup>,
  )
  fireEvent.click(container.querySelector('.sb-group-children .sb-row')!)
  expect(onChild).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
})
