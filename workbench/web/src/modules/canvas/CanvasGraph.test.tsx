import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasGraph, type CanvasGraphProps } from './index'

const nodes = [
  { id: 'a', label: '准备', position: { x: 0, y: 0 } },
  { id: 'b', label: '验收', position: { x: 400, y: 100 } },
  { id: 'c', label: '交付', position: { x: 800, y: 150 } },
]
const edges = [{ id: 'ab', from: 'a', to: 'b' }]

// Supply only the geometry missing from jsdom, leaving React Flow's interactions intact.
const measure = new Set<() => void>()
class CanvasResizeObserver {
  private entries = new Set<Element>()
  constructor(private readonly callback: (entries: { target: Element }[]) => void) {}
  observe(element: Element) {
    this.entries.add(element)
    measure.add(this.flush)
  }
  unobserve(element: Element) { this.entries.delete(element) }
  disconnect() { this.entries.clear(); measure.delete(this.flush) }
  private flush = () => {
    measure.delete(this.flush)
    this.callback([...this.entries].map((target) => ({ target })))
  }
}

beforeEach(() => {
  measure.clear()
  vi.stubGlobal('ResizeObserver', CanvasResizeObserver)
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-flow__node') ? 256 : this.classList.contains('react-flow__handle') ? 10 : 1300
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('react-flow__node') ? 60 : this.classList.contains('react-flow__handle') ? 10 : 500
  })
})

afterEach(cleanup)

function layout() { act(() => [...measure].forEach((flush) => flush())) }

function renderCanvas(options: Partial<CanvasGraphProps> = {}) {
  const props = { nodes, edges, onMove: vi.fn(), ...options }
  const view = render(<CanvasGraph {...props} />)
  return { update: (changes: Partial<CanvasGraphProps>) => view.rerender(<CanvasGraph {...props} {...changes} />) }
}

function node(id: string) { return screen.getByTestId(`rf__node-${id}`) }
function viewport() { return screen.getByRole('application').querySelector<HTMLElement>('.react-flow__viewport')! }

function mouse(target: Element | Document, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, buttons: type === 'mouseup' ? 0 : 1 })
  Object.defineProperty(event, 'view', { value: window })
  fireEvent(target, event)
}

describe('CanvasGraph', () => {
  it('temporarily moves a card while dragging, then reports the drop and accepts caller positions', async () => {
    const onMove = vi.fn()
    const { update } = renderCanvas({ onMove })
    layout()

    mouse(screen.getByText('准备'), 'mousedown', 200, 200)
    mouse(document, 'mousemove', 205, 205)
    mouse(document, 'mousemove', 265, 235)
    expect(node('a')).toHaveStyle({ transform: 'translate(60px,30px)' })
    expect(onMove).not.toHaveBeenCalled()

    const updated = [{ ...nodes[0], label: '准备中', position: { x: 7, y: 8 } }, ...nodes.slice(1)]
    update({ nodes: updated })
    expect(screen.getByText('准备中')).toBeVisible()
    expect(node('a')).toHaveStyle({ transform: 'translate(60px,30px)' })
    mouse(document, 'mouseup', 265, 235)
    expect(onMove).toHaveBeenCalledExactlyOnceWith('a', { x: 60, y: 30 })
    expect(node('a')).toHaveStyle({ transform: 'translate(7px,8px)' })

    update({ nodes: [{ ...nodes[0], position: { x: 64, y: 32 } }, ...nodes.slice(1)] })
    expect(node('a')).toHaveStyle({ transform: 'translate(64px,32px)' })
    update({ nodes })
    expect(node('a')).toHaveStyle({ transform: 'translate(0px,0px)' })
    // D3 temporarily suppresses the click following a drag in the current event loop turn.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('selects a node or edge, opens on double click and leaves custom actions independent', () => {
    const onSelectNode = vi.fn()
    const onSelectEdge = vi.fn()
    const onOpenNode = vi.fn()
    const action = vi.fn()
    renderCanvas({
      nodes: [{ ...nodes[0], content: <button onClick={action}>卡内操作</button> }, ...nodes.slice(1)],
      onSelectNode, onSelectEdge, onOpenNode, showMiniMap: true,
    })
    layout()
    fireEvent.click(screen.getByRole('button', { name: '卡内操作' }))
    fireEvent.doubleClick(screen.getByRole('button', { name: '卡内操作' }))
    expect(action).toHaveBeenCalledOnce()
    expect(onSelectNode).not.toHaveBeenCalled()
    expect(onOpenNode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('准备'))
    expect(node('a')).toHaveClass('selected')
    expect(onSelectNode).toHaveBeenCalledExactlyOnceWith('a')
    fireEvent.doubleClick(screen.getByText('准备'))
    expect(onOpenNode).toHaveBeenCalledExactlyOnceWith('a')

    const edge = screen.getByRole('group', { name: '准备 → 验收' })
    fireEvent.click(edge)
    expect(edge).toHaveClass('selected')
    expect(node('a')).not.toHaveClass('selected')
    expect(onSelectEdge).toHaveBeenCalledExactlyOnceWith('ab')
    expect(screen.getByLabelText('画布缩略图')).toBeInTheDocument()
  })

  it('enables edge edits only when requested and leaves edge data controlled by the caller', () => {
    const onConnect = vi.fn()
    const onReconnect = vi.fn()
    const { update } = renderCanvas({ onConnect, onReconnect })
    layout()
    const source = node('a').querySelector('.source')!
    const target = node('c').querySelector('.target')!
    const edge = screen.getByTestId('rf__edge-ab')
    expect(source).not.toHaveClass('connectable')
    expect(edge.querySelector('.react-flow__edgeupdater-target')).toBeNull()
    fireEvent.click(source)
    fireEvent.click(target)
    expect(onConnect).not.toHaveBeenCalled()

    update({ editableEdges: true })
    const hitTest = vi.fn(() => target)
    Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true })
    try {
      fireEvent.click(source)
      fireEvent.click(target)
      expect(onConnect).toHaveBeenCalledExactlyOnceWith('a', 'c')

      const anchor = edge.querySelector('.react-flow__edgeupdater-target')!
      mouse(anchor, 'mousedown', 400, 100)
      mouse(document, 'mousemove', 800, 150)
      mouse(document, 'mouseup', 800, 150)
      expect(onReconnect).toHaveBeenCalledExactlyOnceWith('ab', 'a', 'c')
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
    expect(screen.queryByRole('group', { name: '准备 → 交付' })).not.toBeInTheDocument()
    update({ editableEdges: true, edges: [{ id: 'ab', from: 'a', to: 'c' }] })
    expect(screen.getByRole('group', { name: '准备 → 交付' })).toBeInTheDocument()
  })

  it('waits for a late focus target to be measured and recenters only on a new request', async () => {
    const { update } = renderCanvas({ nodes: nodes.slice(0, 1), focusNodeId: 'b' })
    layout()
    const fitted = viewport().style.transform
    update({ nodes, focusNodeId: 'b' })
    expect(viewport().style.transform).toBe(fitted)
    layout()
    await waitFor(() => expect(viewport().style.transform).toBe('translate(122px,120px) scale(1)'))

    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    const zoomed = viewport().style.transform
    expect(zoomed).not.toBe('translate(122px,120px) scale(1)')
    update({ nodes: nodes.map((item) => ({ ...item })), focusNodeId: 'b' })
    expect(viewport().style.transform).toBe(zoomed)

    update({ nodes, focusNodeId: 'a' })
    await waitFor(() => expect(viewport().style.transform).toBe('translate(496.4px,214px) scale(1.2)'))
  })
})
