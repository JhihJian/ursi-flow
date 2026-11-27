// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ContextMenu, type MenuItem, type MenuState } from './context-menu'

afterEach(() => {
  cleanup()
})

/** 菜单高度按「行数 × 行高 + 标题行」估算，测试里用它核对夹取结果。 */
const MENU_WIDTH = 200

const items: MenuItem[] = [
  { label: '编辑', onSelect: () => {} },
  { label: '删除', danger: true, onSelect: () => {} },
]

/** 给容器一个确定的尺寸：jsdom 不做布局，getBoundingClientRect 默认全 0。 */
function mount(state: MenuState | null, bounds = { left: 100, top: 50, width: 300, height: 400 }) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.getBoundingClientRect = () => ({
    ...bounds,
    right: bounds.left + bounds.width,
    bottom: bounds.top + bounds.height,
    x: bounds.left,
    y: bounds.top,
    toJSON: () => ({}),
  })
  const onClose = vi.fn()
  const view = render(<ContextMenu state={state} onClose={onClose} container={host} />)
  return { host, onClose, ...view }
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1024)
  vi.stubGlobal('innerHeight', 768)
})

test('不渲染到 document.body，只 portal 进传入的容器', () => {
  const { host, container } = mount({ x: 10, y: 10, items })
  expect(host.querySelector('[role="menu"]')).not.toBeNull()
  // testing-library 的 render 容器里什么都没有，body 下也没有 portal 节点。
  expect(container.childElementCount).toBe(0)
  expect(document.body.querySelector(':scope > [role="menu"]')).toBeNull()
  expect(host.contains(document.querySelector('[role="menu"]'))).toBe(true)
})

test('state 为 null 时什么都不渲染', () => {
  const { host } = mount(null)
  expect(host.childElementCount).toBe(0)
})

test('坐标是容器相对坐标，直接作为 left/top', () => {
  const { host } = mount({ x: 40, y: 60, items })
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.style.left).toBe('40px')
  expect(menu.style.top).toBe('60px')
  expect(menu.style.width).toBe(`${MENU_WIDTH}px`)
})

test('右侧放不下时向左翻到指针左边，翻过去也不够时贴左对齐', () => {
  // 容器宽 300，菜单宽 200：x=250 时右边只剩 50，放不下。
  const { host } = mount({ x: 250, y: 10, items })
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!
  // 左翻：x - 宽 - 间距 = 46
  expect(menu.style.left).toBe('46px')

  cleanup()
  // 窄容器只有 150 宽，怎么翻都放不下，贴左。
  const narrow = mount({ x: 140, y: 10, items }, { left: 0, top: 0, width: 150, height: 400 })
  expect(narrow.host.querySelector<HTMLElement>('[role="menu"]')!.style.left).toBe('4px')
})

test('下方放不下时上移，使菜单底边贴容器底边', () => {
  // 容器高 400，2 行 = 60 高，y=390 时下方只剩 10。
  const { host } = mount({ x: 10, y: 390, items })
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!
  // 400 - 60 - 8 = 332
  expect(menu.style.top).toBe('332px')
})

test('标题行占一行高度', () => {
  const { host } = mount({ x: 10, y: 390, items, heading: '确认？' })
  const menu = host.querySelector<HTMLElement>('[role="menu"]')!
  // 400 - 90 - 8 = 302
  expect(menu.style.top).toBe('302px')
  expect(menu.textContent).toContain('确认？')
})

test('渲染每个菜单项，danger 加修饰类，disabled 加 title 说明', () => {
  const { host } = mount({
    x: 10,
    y: 10,
    items: [
      { label: '复制', onSelect: () => {} },
      { label: '删除', danger: true, onSelect: () => {} },
      { label: '释放', onSelect: () => {}, disabled: true, reason: '没有运行时' },
      { label: '勾选', onSelect: () => {}, checked: true },
      { label: '图标', onSelect: () => {}, icon: <i data-testid="ico">i</i> },
    ],
  })
  const rows = host.querySelectorAll('[role="menuitem"]')
  expect(rows).toHaveLength(5)
  expect(rows[0]!.className).toBe('sb-menu-item')
  expect(rows[1]!.className).toBe('sb-menu-item danger')
  expect(rows[2]!.className).toBe('sb-menu-item')
  expect(rows[2]!.hasAttribute('disabled')).toBe(true)
  expect(rows[2]!.getAttribute('title')).toBe('没有运行时')
  expect(rows[3]!.className).toBe('sb-menu-item is-checked')
  expect(rows[3]!.textContent).toContain('✓')
  expect(rows[4]!.querySelector('[data-testid="ico"]')).not.toBeNull()
})

test('点菜单项：先关闭，再执行 onSelect；disabled 项不执行', () => {
  const onSelect = vi.fn()
  const { host, onClose } = mount({
    x: 10,
    y: 10,
    items: [
      { label: '可点', onSelect },
      { label: '禁用', onSelect, disabled: true },
    ],
  })
  const rows = host.querySelectorAll<HTMLElement>('[role="menuitem"]')
  fireEvent.click(rows[0]!)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledTimes(1)

  fireEvent.click(rows[1]!)
  expect(onSelect).toHaveBeenCalledTimes(1)
})

test('点容器内其它地方关闭，且拦住这次 pointerdown 不让它冒到宿主', () => {
  const { host, onClose } = mount({ x: 10, y: 10, items })
  const outside = document.createElement('button')
  host.appendChild(outside)
  const seenByHost = vi.fn()
  host.addEventListener('pointerdown', seenByHost)
  fireEvent.pointerDown(outside)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(seenByHost).not.toHaveBeenCalled()
})

test('点外面时 click 照常到宿主：菜单开着时点另一行就是切到那一行，不用点两次', () => {
  const { host, onClose } = mount({ x: 10, y: 10, items })
  const row = document.createElement('button')
  host.appendChild(row)
  const clicked = vi.fn()
  row.addEventListener('click', clicked)
  // 真实点击是 pointerdown 后跟 click；这里分两次触发，确认后者不被拦。
  fireEvent.pointerDown(row)
  fireEvent.click(row)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(clicked).toHaveBeenCalledTimes(1)
})

test('点菜单自身不关闭', () => {
  const { host, onClose } = mount({ x: 10, y: 10, items })
  fireEvent.pointerDown(host.querySelector('[role="menu"]')!)
  expect(onClose).not.toHaveBeenCalled()
})

test('Escape 关闭，其它键不关', () => {
  const { onClose } = mount({ x: 10, y: 10, items })
  fireEvent.keyDown(window, { key: 'a' })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('窗口 resize 关闭', () => {
  const { onClose } = mount({ x: 10, y: 10, items })
  fireEvent(window, new Event('resize'))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('页面滚动关闭，菜单自身内滚不关', () => {
  const { host, onClose } = mount({ x: 10, y: 10, items })
  fireEvent.scroll(host.querySelector('[role="menu"]')!)
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.scroll(document)
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('容器内的滚动容器滚动也关闭：菜单挂在不滚动的外层，列表在内层滚', () => {
  const { host, onClose } = mount({ x: 10, y: 10, items })
  // 模拟 todo 项目列表的结构：菜单与列表是兄弟，列表自己滚。
  const list = document.createElement('div')
  host.prepend(list)
  fireEvent.scroll(list)
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('state 清空后监听被移除，不再触发 onClose', () => {
  const { host, onClose, rerender } = mount({ x: 10, y: 10, items })
  rerender(<ContextMenu state={null} onClose={onClose} container={host} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
})

test('容器尚未挂载（null）时不渲染也不报错', () => {
  const onClose = vi.fn()
  const view = render(<ContextMenu state={{ x: 1, y: 1, items }} onClose={onClose} container={null} />)
  expect(view.container.childElementCount).toBe(0)
  expect(onClose).not.toHaveBeenCalled()
  act(() => {
    fireEvent.keyDown(window, { key: 'Escape' })
  })
  expect(onClose).not.toHaveBeenCalled()
})

test('菜单项数量变化时位置按新高度重算', () => {
  const { host, rerender, onClose } = mount({ x: 10, y: 390, items })
  expect(host.querySelector<HTMLElement>('[role="menu"]')!.style.top).toBe('332px')
  rerender(
    <ContextMenu
      state={{ x: 10, y: 390, items: [...items, ...items, ...items] }}
      onClose={onClose}
      container={host}
    />,
  )
  // 6 行 = 180，400 - 180 - 8 = 212
  expect(host.querySelector<HTMLElement>('[role="menu"]')!.style.top).toBe('212px')
})

test('打开后焦点进第一个可用项；关闭后还给打开前的焦点元素', () => {
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  const { host, rerender, onClose } = mount({
    x: 10,
    y: 10,
    items: [{ label: '不可用', disabled: true, onSelect: () => {} }, ...items],
  })
  const first = host.querySelector<HTMLButtonElement>('.sb-menu-item:not(:disabled)')!
  expect(document.activeElement).toBe(first)
  expect(first.textContent).toBe('编辑')

  rerender(<ContextMenu state={null} onClose={onClose} container={host} />)
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

test('二次确认换菜单时焦点不还回去，直接进新菜单的第一项', () => {
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  const { host, rerender, onClose } = mount({ x: 10, y: 10, items })
  rerender(
    <ContextMenu
      state={{ x: 10, y: 10, heading: '确认？', items: [{ label: '删除', danger: true, onSelect: () => {} }] }}
      onClose={onClose}
      container={host}
    />,
  )
  expect(document.activeElement).not.toBe(opener)
  expect(document.activeElement?.textContent).toBe('删除')
  rerender(<ContextMenu state={null} onClose={onClose} container={host} />)
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

test('父组件重渲染不把焦点拉回第一项：用户 Tab 到别的项后列表刷新，焦点留在原处', () => {
  const { host, rerender, onClose } = mount({ x: 10, y: 10, items })
  const buttons = host.querySelectorAll<HTMLButtonElement>('.sb-menu-item')
  buttons[1].focus()
  // 调用方传了新的 state 对象（如菜单项按最新数据重算），位置 effect 会重跑。
  rerender(<ContextMenu state={{ x: 10, y: 10, items: [...items] }} onClose={onClose} container={host} />)
  expect(document.activeElement).toBe(buttons[1])
})
