import { FitAddon, type ITerminalDimensions } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'

const MINIMUM_COLS = 2
const MINIMUM_ROWS = 1
const DEFAULT_SCROLL_BAR_WIDTH = 14
/** 面板拖拽时 ResizeObserver 连续触发，最多等 8 帧让列行稳定下来再 fit。 */
const MAX_STABILITY_FRAMES = 8

export interface TerminalSize {
  cols: number
  rows: number
}

type CellSize = { width: number; height: number }

/** xterm 6.0 的 typings 没有公开 dimensions，实际值挂在 renderService 上。 */
interface TerminalRenderDimensions {
  css: { cell: CellSize }
  device: { cell: CellSize }
}

function readRenderDimensions(terminal: Terminal): TerminalRenderDimensions | null {
  const dimensions = (
    terminal as Terminal & {
      _core?: { _renderService?: { dimensions?: TerminalRenderDimensions } }
    }
  )._core?._renderService?.dimensions
  return dimensions ?? null
}

// xterm 的 canvas 宽高按当前列数四舍五入，同一个盒子从 75 列量出 51、从 52 列量出 52。
// 所以只信 device cell 尺寸，不参与除法。取自 orca 的 readTerminalStableCellSize。
function readStableCellSize(terminal: Terminal): CellSize | null {
  const dimensions = readRenderDimensions(terminal)
  if (!dimensions) return null
  const dpr = terminal.element?.ownerDocument.defaultView?.devicePixelRatio || 1
  const width = dimensions.device.cell.width / dpr
  const height = dimensions.device.cell.height / dpr
  if (width > 0 && height > 0) return { width, height }
  const css = dimensions.css.cell
  return css.width > 0 && css.height > 0 ? { width: css.width, height: css.height } : null
}

export interface TerminalFitBox {
  width: number
  height: number
  padding: { top: number; right: number; bottom: number; left: number }
  scrollbarWidth: number
}

/** 给定盒子与 cell 尺寸时的列行数，语义与 FitAddon.proposeDimensions 一致。 */
export function terminalGridSizeForBox(box: TerminalFitBox, cell: { width: number; height: number }): TerminalSize {
  const { padding, scrollbarWidth } = box
  // FitAddon 用 parseInt 读计算宽度，小数会被截断，这里显式 trunc。
  const width = Math.max(0, Math.trunc(box.width)) - padding.left - padding.right - scrollbarWidth
  const height = Math.max(0, Math.trunc(box.height)) - padding.top - padding.bottom
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(width / cell.width)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(height / cell.height)),
  }
}

/**
 * FitAddon 的 proposal 只取决于盒子，与本终端当前列数无关。
 * 原生实现会随列数变化漂移一列，导致拖拽分隔条时远端 SIGWINCH 反复抖动。
 */
export class StableCellFitAddon extends FitAddon {
  private stableCellTerminal: Terminal | null = null

  public override activate(terminal: Terminal): void {
    this.stableCellTerminal = terminal
    super.activate(terminal)
  }

  public override proposeDimensions(): ITerminalDimensions | undefined {
    const terminal = this.stableCellTerminal
    const host = terminal?.element?.parentElement
    if (!terminal?.element || !host) return undefined
    const cell = readStableCellSize(terminal)
    const view = terminal.element.ownerDocument.defaultView
    if (!cell || !view) return super.proposeDimensions()

    const hostStyle = view.getComputedStyle(host)
    const elementStyle = view.getComputedStyle(terminal.element)
    const px = (style: CSSStyleDeclaration, property: string) =>
      Number.parseInt(style.getPropertyValue(property), 10) || 0
    const scrollbarWidth =
      terminal.options.scrollback === 0 ? 0 : (terminal.options.overviewRuler?.width ?? DEFAULT_SCROLL_BAR_WIDTH)

    return terminalGridSizeForBox(
      {
        width: host.clientWidth || px(hostStyle, 'width'),
        height: host.clientHeight || px(hostStyle, 'height'),
        padding: {
          // host 的内边距和 xterm 元素自身的内边距都要扣掉，否则会算出放不下的列行。
          top: px(hostStyle, 'padding-top') + px(elementStyle, 'padding-top'),
          right: px(hostStyle, 'padding-right') + px(elementStyle, 'padding-right'),
          bottom: px(hostStyle, 'padding-bottom') + px(elementStyle, 'padding-bottom'),
          left: px(hostStyle, 'padding-left') + px(elementStyle, 'padding-left'),
        },
        scrollbarWidth,
      },
      cell,
    )
  }
}

/**
 * fit 调度器：ResizeObserver 抖动时用 requestAnimationFrame 合并，
 * 连续两帧给出同样的列行才落盘，避免拖拽分隔条把远端 PTY 拖成 SIGWINCH 风暴。
 */
export class TerminalFitter {
  private frameId: number | null = null
  private frameCount = 0
  private previous: TerminalSize | null = null
  private disposed = false

  constructor(
    private readonly terminal: Terminal,
    private readonly fitAddon: StableCellFitAddon,
    private readonly onSettled: () => void,
  ) {}

  public propose(): TerminalSize | null {
    try {
      return this.fitAddon.proposeDimensions() ?? null
    } catch {
      return null
    }
  }

  /** 立即 fit，返回落盘后的列行；不可测量时返回 null。 */
  public fitNow(): TerminalSize | null {
    const proposed = this.propose()
    if (!proposed) return null
    if (proposed.cols !== this.terminal.cols || proposed.rows !== this.terminal.rows) {
      try {
        this.fitAddon.fit()
      } catch {
        return null
      }
    }
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  public scheduleStableFit(): void {
    if (this.disposed || this.frameId !== null) return
    this.frameCount = 0
    this.previous = this.propose()
    this.frameId = requestAnimationFrame(this.waitForStableGrid)
  }

  public dispose(): void {
    this.disposed = true
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.frameId = null
  }

  private readonly waitForStableGrid = (): void => {
    this.frameId = null
    if (this.disposed) return
    if (!this.isMeasurable()) return
    const next = this.propose()
    this.frameCount += 1
    const sameAsTerminal =
      next !== null && next.cols === this.terminal.cols && next.rows === this.terminal.rows
    const sameAsPrevious =
      next !== null &&
      this.previous !== null &&
      next.cols === this.previous.cols &&
      next.rows === this.previous.rows
    if (!next || sameAsTerminal || sameAsPrevious || this.frameCount >= MAX_STABILITY_FRAMES) {
      this.fitNow()
      this.onSettled()
      return
    }
    this.previous = next
    this.frameId = requestAnimationFrame(this.waitForStableGrid)
  }

  private isMeasurable(): boolean {
    const host = this.terminal.element?.parentElement
    return host ? host.clientWidth > 0 && host.clientHeight > 0 : false
  }
}
