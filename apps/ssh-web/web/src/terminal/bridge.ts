import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { terminalWsUrl } from '../api/client'
import type { ControlFrame, EventFrame } from '../api/types'
import type { TerminalTarget } from '../store/ssh-store'
import { StableCellFitAddon, TerminalFitter, type TerminalSize } from './fit'
import { createLinkTooltip, createTerminalLinkProvider } from './links'
import { buildTerminalOptions } from './options'
import { TerminalRenderer } from './renderer'
import { sameTerminalTheme, terminalMinimumContrastRatio, terminalTheme } from './theme'
import { activateTerminalUnicode } from './unicode'

/** 输入分片大小，与服务端 64KB 文本帧上限对齐并留余量。 */
const CHUNK_SIZE = 8192
/** 待发送字节超过该值视为远端无响应，主动断开避免无限堆积。 */
const MAX_BUFFERED = 1_048_576
/** 拖拽面板时 fit 会连续触发，resize 命令合并后再发。 */
const PTY_RESIZE_DEBOUNCE_MS = 100
/** 量不出尺寸时（面板隐藏）的兜底列行，与服务端默认值一致。 */
const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 }

export interface TerminalEvent {
  kind: 'error' | 'closed'
  message: string
}

export interface TerminalBridgeOptions {
  host: HTMLElement
  tooltip: HTMLElement
  target: TerminalTarget
  light: boolean
  onEvent: (event: TerminalEvent) => void
  onSearchRequest: () => void
}

export interface TerminalBridge {
  searchAddon: SearchAddon
  setTheme: (light: boolean) => void
  focus: () => void
  dispose: () => void
}

function sendChunked(socket: WebSocket, data: string): void {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const frame: ControlFrame = { type: 'input', data: data.slice(offset, offset + CHUNK_SIZE) }
    socket.send(JSON.stringify(frame))
  }
}

function parseEventFrame(raw: string): EventFrame | null {
  try {
    const frame = JSON.parse(raw) as EventFrame
    return frame.type === 'error' || frame.type === 'closed' ? frame : null
  } catch {
    return null
  }
}

/**
 * 建一条 WS ↔ xterm 桥。
 * 关键顺序：先 open + 量尺寸，再带着真实列行连 WS，远端 PTY 一次就按面板大小建好，
 * 不会先按 80×24 排版再被 resize 冲刷一遍。
 */
export function openTerminalBridge(options: TerminalBridgeOptions): TerminalBridge {
  const { host, tooltip: tooltipElement, target } = options
  const terminal = new Terminal(buildTerminalOptions(options.light))
  const fitAddon = new StableCellFitAddon()
  const searchAddon = new SearchAddon()
  const unicodeAddon = new Unicode11Addon()
  const tooltip = createLinkTooltip(tooltipElement)

  terminal.open(host)
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(unicodeAddon)
  // 必须在任何 write 之前激活：Unicode 6 的宽度表会把中文和 emoji 量错格。
  activateTerminalUnicode(terminal)
  terminal.registerLinkProvider(createTerminalLinkProvider(terminal, tooltip))

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      options.onSearchRequest()
      return false
    }
    return true
  })

  let socket: WebSocket | null = null
  let renderer: TerminalRenderer | null = null
  let forwardedSize: TerminalSize = FALLBACK_SIZE
  let pendingSize: TerminalSize | null = null
  let forwardTimer: ReturnType<typeof setTimeout> | null = null

  const forwardNow = (size: TerminalSize): void => {
    pendingSize = null
    if (forwardTimer) clearTimeout(forwardTimer)
    forwardTimer = null
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (size.cols === forwardedSize.cols && size.rows === forwardedSize.rows) return
    socket.send(JSON.stringify({ type: 'resize', ...size } satisfies ControlFrame))
    forwardedSize = size
  }

  // 只保留最后一次目标尺寸，拖拽结束后一次 resize 同步到远端，避免 SIGWINCH 风暴。
  const scheduleForward = (size: TerminalSize): void => {
    if (size.cols === forwardedSize.cols && size.rows === forwardedSize.rows) return
    pendingSize = size
    if (forwardTimer) return
    forwardTimer = setTimeout(() => {
      forwardTimer = null
      if (pendingSize) forwardNow(pendingSize)
    }, PTY_RESIZE_DEBOUNCE_MS)
  }

  const syncSize = (): void => {
    if (terminal.cols < 1 || terminal.rows < 1) return
    scheduleForward({ cols: terminal.cols, rows: terminal.rows })
  }

  const handleFitSettled = (): void => {
    renderer?.repairDevicePixelRatio()
    syncSize()
  }

  const fitter = new TerminalFitter(terminal, fitAddon, handleFitSettled)
  const initialSize = fitter.fitNow() ?? FALLBACK_SIZE
  forwardedSize = initialSize

  renderer = new TerminalRenderer({
    terminal,
    onRendererChanged: () => {
      // WebGL 与 DOM 的 cell 尺寸不同，换渲染器后要重排、重绘并把新列行同步给远端。
      // WS 还没连上时不动 forwardedSize：onopen 会按当时的真实列行重新对齐。
      fitter.fitNow()
      renderer?.refresh()
      if (socket?.readyState === WebSocket.OPEN) {
        forwardNow({ cols: terminal.cols, rows: terminal.rows })
      }
    },
  })
  renderer.attach()

  socket = new WebSocket(
    terminalWsUrl(target.connectionId, target.tmuxSession ?? undefined, initialSize.cols, initialSize.rows),
  )
  socket.binaryType = 'arraybuffer'

  // 握手期间面板可能已经变过尺寸，连上后按当前列行补一次，远端 PTY 才不会停在旧尺寸。
  socket.onopen = () => {
    const size = fitter.fitNow()
    forwardNow(size ?? { cols: terminal.cols, rows: terminal.rows })
  }

  terminal.onData((data) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.close()
      return
    }
    sendChunked(socket, data)
  })

  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const frame = parseEventFrame(event.data)
      if (!frame) return
      const color = frame.type === 'error' ? 31 : 33
      terminal.writeln('')
      terminal.writeln(`\x1b[${color}m${frame.message}\x1b[0m`)
      options.onEvent({ kind: frame.type, message: frame.message })
      return
    }
    terminal.write(new Uint8Array(event.data as ArrayBuffer))
  }

  const resizeObserver = new ResizeObserver(() => fitter.scheduleStableFit())
  resizeObserver.observe(host)

  // 切回标签页时浏览器可能丢了重绘，重排 + 重绘 + 修 DPR，避免画面停在旧帧。
  const handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return
    fitter.scheduleStableFit()
    renderer?.repairDevicePixelRatio()
    renderer?.refresh()
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // 跨屏拖动会改 devicePixelRatio 但不改 CSS 尺寸，靠 matchMedia 单独盯一次。
  let dprQuery: MediaQueryList | null = null
  const handleDprChange = (): void => {
    watchDevicePixelRatio()
    fitter.fitNow()
    renderer?.repairDevicePixelRatio()
    renderer?.refresh()
    syncSize()
  }
  const watchDevicePixelRatio = (): void => {
    dprQuery?.removeEventListener('change', handleDprChange)
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprQuery.addEventListener('change', handleDprChange)
  }
  watchDevicePixelRatio()

  return {
    searchAddon,
    setTheme(light: boolean) {
      const next = terminalTheme(light)
      // 主题值没变就不写 options.theme：写入会重建调色板并丢掉 TUI 自己的 OSC 4/10/11 改色。
      if (!sameTerminalTheme(terminal.options.theme, next)) terminal.options.theme = next
      terminal.options.minimumContrastRatio = terminalMinimumContrastRatio(light)
      renderer?.refresh()
    },
    focus() {
      terminal.focus()
    },
    dispose() {
      if (forwardTimer) clearTimeout(forwardTimer)
      forwardTimer = null
      pendingSize = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      dprQuery?.removeEventListener('change', handleDprChange)
      dprQuery = null
      resizeObserver.disconnect()
      fitter.dispose()
      renderer?.dispose()
      renderer = null
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.close()
        socket = null
      }
      tooltip.hide()
      terminal.dispose()
    },
  }
}
