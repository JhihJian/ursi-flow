import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

/**
 * 渲染器策略取自 orca：
 * - 只在 WebGL2 可用且拿到硬件渲染器身份时才开 GPU 渲染，软件渲染（llvmpipe/SwiftShader）
 *   会画出错字，宁可留在 DOM 渲染。
 * - 上下文丢失后立刻释放 GPU 上下文并退回 DOM，重排 + 重绘，不让画面停在空白画布上。
 * - 60 秒窗口内丢 3 次以上就彻底留在 DOM，避免无限重建上下文把浏览器拖死。
 */

const SOFTWARE_RENDERER_PATTERN =
  /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i
const CONTEXT_LOSS_RETRY_LIMIT = 3
const CONTEXT_LOSS_RETRY_WINDOW_MS = 60_000

type RendererKind = 'webgl' | 'dom'

interface WebglInternals {
  _renderer?: {
    _gl?: { getExtension(name: 'WEBGL_lose_context'): WEBGL_lose_context | null; isContextLost?(): boolean }
    _canvas?: HTMLCanvasElement
  }
}

interface RendererInternals {
  _canvas?: HTMLCanvasElement
  _devicePixelRatio?: number
  _gl?: { canvas?: HTMLCanvasElement }
  dimensions?: { device?: { canvas?: { width?: number; height?: number } } }
  handleDevicePixelRatioChange?: () => void
  handleResize?: (cols: number, rows: number) => void
}

let webglAvailability: boolean | null = null

/** 是否值得尝试 WebGL：WebGL2 存在且不是软件渲染。结果缓存，失败后不再反复探测。 */
export function canUseWebgl(): boolean {
  if (webglAvailability !== null) return webglAvailability
  if (typeof document === 'undefined') return false
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) {
      webglAvailability = false
      return false
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) {
      // 拿不到渲染器身份时无法排除软渲染；orca 在这种情况下也退回 DOM。
      webglAvailability = false
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return false
    }
    const identity = `${String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '')} ${String(
      gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '',
    )}`
    webglAvailability = !SOFTWARE_RENDERER_PATTERN.test(identity)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    webglAvailability = false
  }
  return webglAvailability
}

export interface TerminalRendererOptions {
  terminal: Terminal
  /** 渲染器切换后需要重新量尺寸并同步 PTY，由桥接层提供。 */
  onRendererChanged: () => void
}

export class TerminalRenderer {
  private addon: WebglAddon | null = null
  private disabled = false
  private lossTimestamps: number[] = []

  constructor(private readonly options: TerminalRendererOptions) {}

  public get kind(): RendererKind {
    return this.addon ? 'webgl' : 'dom'
  }

  public attach(): void {
    if (this.disabled || this.addon) return
    if (!canUseWebgl()) {
      this.disabled = true
      return
    }
    let addon: WebglAddon
    try {
      addon = new WebglAddon()
    } catch {
      // 拿不到上下文就留在 DOM 渲染，不重试。
      this.disabled = true
      return
    }
    addon.onContextLoss(() => this.handleContextLoss(addon))
    try {
      this.options.terminal.loadAddon(addon)
      this.addon = addon
    } catch {
      safeDispose(addon)
      this.disabled = true
      return
    }
    this.options.onRendererChanged()
  }

  /**
   * 重新呈现整个视口。切回标签页、切主题、WebGL 换成 DOM 之后调用，
   * 否则画布会停在切换那一刻的旧帧上。
   */
  public refresh(): void {
    const { terminal } = this.options
    if (terminal.rows < 1) return
    try {
      terminal.refresh(0, terminal.rows - 1)
    } catch {
      // 终端可能正在 dispose。
    }
  }

  /**
   * 跨屏拖动或系统缩放变化时，WebGL 画布可能还停在旧 DPR 的像素尺寸上。
   * 用 xterm 自己的 resize 路径重建 backing store，再重绘。
   */
  public repairDevicePixelRatio(): void {
    const renderer = getRendererInternals(this.options.terminal)
    const canvas = renderer?._canvas ?? renderer?._gl?.canvas
    const expected = renderer?.dimensions?.device?.canvas
    const view = canvas?.ownerDocument.defaultView
    const expectedWidth = expected?.width ?? 0
    const expectedHeight = expected?.height ?? 0
    if (!renderer || !canvas || !canvas.isConnected || !view) return
    if (expectedWidth <= 0 || expectedHeight <= 0) return
    const cachedDpr = renderer._devicePixelRatio
    const dprChanged = typeof cachedDpr === 'number' && cachedDpr !== view.devicePixelRatio
    const tolerance = Math.max(1, Math.ceil(view.devicePixelRatio / 2))
    if (
      !dprChanged &&
      Math.abs(canvas.width - expectedWidth) <= tolerance &&
      Math.abs(canvas.height - expectedHeight) <= tolerance
    ) {
      return
    }
    try {
      renderer.handleDevicePixelRatioChange?.()
      renderer.handleResize?.(this.options.terminal.cols, this.options.terminal.rows)
      this.refresh()
    } catch {
      // 面板可能正在卸载，下一次可见性变化会重试。
    }
  }

  public dispose(): void {
    if (!this.addon) return
    const addon = this.addon
    this.addon = null
    releaseWebglContext(addon)
    safeDispose(addon)
  }

  private handleContextLoss(addon: WebglAddon): void {
    if (this.addon !== addon) return
    this.addon = null
    releaseWebglContext(addon)
    safeDispose(addon)
    if (this.recordContextLoss() >= CONTEXT_LOSS_RETRY_LIMIT) this.disabled = true
    // WebGL 和 DOM 的 cell 尺寸不同，必须重排后再重绘并同步 PTY。
    this.options.onRendererChanged()
  }

  private recordContextLoss(): number {
    const now = Date.now()
    const cutoff = now - CONTEXT_LOSS_RETRY_WINDOW_MS
    this.lossTimestamps = [...this.lossTimestamps.filter((at) => at > cutoff), now]
    return this.lossTimestamps.length
  }
}

function safeDispose(addon: WebglAddon): void {
  try {
    addon.dispose()
  } catch {
    // addon 已经失去上下文时 dispose 可能抛错。
  }
}

/** Windows/ANGLE 会在 canvas 移除后保留驱动上下文，显式 loseContext 以免耗尽浏览器上下文预算。 */
function releaseWebglContext(addon: WebglAddon): void {
  try {
    const renderer = (addon as WebglAddon & WebglInternals)._renderer
    renderer?._gl?.getExtension('WEBGL_lose_context')?.loseContext()
    if (renderer?._canvas) {
      renderer._canvas.width = 0
      renderer._canvas.height = 0
    }
  } catch {
    // 内部结构随 xterm 版本变化，取不到就跳过。
  }
}

function getRendererInternals(terminal: Terminal): RendererInternals | undefined {
  return (terminal as Terminal & { _core?: { _renderService?: { _renderer?: { value?: RendererInternals } } } })
    ._core?._renderService?._renderer?.value
}
