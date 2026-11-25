import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ContextMenu, type MenuState } from './ContextMenu'
import type { ControlFrame, EventFrame, SessionInfo } from '../api/types'
import { useSshStore } from '../store/ssh-store'

/** 输入分片大小，与服务端 64KB 文本帧上限对齐并留余量。 */
const CHUNK_SIZE = 8192
/** 待发送字节超过该值视为远端无响应，主动断开避免无限堆积。 */
const MAX_BUFFERED = 1_048_576
/** PTY 尺寸上限，与服务端 parse_control 一致。 */
const MAX_COLS = 500
const MAX_ROWS = 500

/** xterm 暗色主题：面板底色 #141414，出版物风格低饱和配色。 */
const TERMINAL_THEME_DARK = {
  background: '#141414',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#141414',
  selectionBackground: '#3a3a3a',
  black: '#141414',
  red: '#b43c3c',
  green: '#5a8a4a',
  yellow: '#b8a03c',
  blue: '#4a6fb4',
  magenta: '#9a5ab4',
  cyan: '#4aa0a0',
  white: '#cccccc',
  brightBlack: '#666666',
  brightRed: '#d46a6a',
  brightGreen: '#7ab06a',
  brightYellow: '#d4c46a',
  brightBlue: '#6a8fd4',
  brightMagenta: '#b47ad4',
  brightCyan: '#6ac0c0',
  brightWhite: '#e6e6e6',
}

/** xterm 亮色主题：白底黑字，与出版物风格一致。 */
const TERMINAL_THEME_LIGHT = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#c9c9c9',
  black: '#1a1a1a',
  red: '#b43c3c',
  green: '#3c6e34',
  yellow: '#8a6d1e',
  blue: '#2e4d8a',
  magenta: '#6e2e8a',
  cyan: '#2e6e6e',
  white: '#cccccc',
  brightBlack: '#666666',
  brightRed: '#d46a6a',
  brightGreen: '#5a9a4a',
  brightYellow: '#b49a3c',
  brightBlue: '#5a7ab4',
  brightMagenta: '#9a5ab4',
  brightCyan: '#4a9a9a',
  brightWhite: '#ffffff',
}

interface Bridge {
  socket: WebSocket
  terminal: Terminal
  fitAddon: FitAddon
  resizeObserver: ResizeObserver
  lastSize: { cols: number; rows: number }
}

function sendChunked(socket: WebSocket, data: string) {
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const frame: ControlFrame = { type: 'input', data: data.slice(offset, offset + CHUNK_SIZE) }
    socket.send(JSON.stringify(frame))
  }
}

function parseSize(width: number, height: number, lastSize: { cols: number; rows: number }) {
  const cols = Math.max(2, Math.min(MAX_COLS, Math.floor(width / 9)))
  const rows = Math.max(2, Math.min(MAX_ROWS, Math.floor(height / 17)))
  if (cols === lastSize.cols && rows === lastSize.rows) return null
  lastSize.cols = cols
  lastSize.rows = rows
  return { cols, rows }
}

/** 建立一条 WS↔xterm 桥；返回清理函数。 */
function openBridge(
  container: HTMLElement,
  session: SessionInfo,
  light: boolean,
): () => void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(
    `${protocol}://${window.location.host}/api/sessions/${encodeURIComponent(session.id)}/ws`,
  )
  socket.binaryType = 'arraybuffer'

  const terminal = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    theme: light ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK,
    scrollback: 5000,
    convertEol: false,
  })
  const fitAddon = new FitAddon()
  terminal.open(container)
  fitAddon.fit()
  const initial = parseSize(
    container.clientWidth || 800,
    container.clientHeight || 480,
    { cols: 0, rows: 0 },
  )
  if (initial) socket.send(JSON.stringify({ type: 'resize', ...initial }))

  terminal.onData((data) => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.close()
      return
    }
    sendChunked(socket, data)
  })

  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const frame = JSON.parse(event.data) as EventFrame
        if (frame.type === 'error') {
          terminal.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`)
        } else if (frame.type === 'closed') {
          terminal.writeln(`\r\n\x1b[33m${frame.message}\x1b[0m`)
        }
      } catch {
        // 非 JSON 文本帧直接忽略。
      }
      return
    }
    terminal.write(new Uint8Array(event.data))
  }

  const lastSize = initial ?? { cols: 80, rows: 24 }
  const resizeObserver = new ResizeObserver(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    fitAddon.fit()
    const size = parseSize(container.clientWidth, container.clientHeight, lastSize)
    if (size) socket.send(JSON.stringify({ type: 'resize', ...size }))
  })
  resizeObserver.observe(container)

  const bridge: Bridge = { socket, terminal, fitAddon, resizeObserver, lastSize }
  return () => {
    resizeObserver.disconnect()
    socket.close()
    terminal.dispose()
    void bridge
  }
}

/** 右侧终端区：选中连接后经桥接展示远端 PTY；右键提供重连与亮暗色切换。 */
export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSession = useSshStore((state) => state.activeSession)
  const connecting = useSshStore((state) => state.connecting)
  const terminalLight = useSshStore((state) => state.terminalLight)
  const reconnectActive = useSshStore((state) => state.reconnectActive)
  const setEditor = useSshStore((state) => state.setEditor)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!activeSession) return
    const cleanup = openBridge(container, activeSession, terminalLight)
    cleanupRef.current = cleanup
    return () => {
      cleanupRef.current = null
      cleanup()
    }
  }, [activeSession, terminalLight])

  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    const items: MenuState['items'] = [
      { label: 'New connection', onSelect: () => setEditor({ kind: 'new' }) },
    ]
    if (activeSession && !connecting) {
      items.push({ label: 'Reconnect', onSelect: () => void reconnectActive() })
    }
    items.push({
      label: terminalLight ? 'Dark terminal' : 'Light terminal',
      onSelect: () => useSshStore.getState().toggleTerminalLight(),
    })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  if (connecting) {
    return (
      <div className="terminal-pane terminal-placeholder" onContextMenu={openMenu}>
        connecting…
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </div>
    )
  }
  if (!activeSession) {
    return (
      <div className="terminal-pane terminal-placeholder" onContextMenu={openMenu}>
        选择或新建一个连接开始会话
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </div>
    )
  }
  return (
    <div
      className={
        terminalLight ? 'terminal-pane terminal-surface light' : 'terminal-pane terminal-surface'
      }
      ref={containerRef}
      onContextMenu={openMenu}
    >
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
