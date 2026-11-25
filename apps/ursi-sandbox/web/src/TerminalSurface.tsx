import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalSurface({
  url,
  status,
}: {
  url: string
  status: (state: 'connecting' | 'connected' | 'failed') => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current!
    const term = new Terminal({
      fontSize: 13,
      scrollback: 2000,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    const ws = new WebSocket(url)
    let lastSize = ''
    const resize = () => {
      if (!element.clientWidth || !element.clientHeight) return
      fit.fit()
      const cols = Math.min(500, term.cols),
        rows = Math.min(500, term.rows)
      const size = `${cols}:${rows}`
      if (ws.readyState === WebSocket.OPEN && size !== lastSize) {
        lastSize = size
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    const input = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      // Include room for UTF-8 and JSON escaping in the server frame limit.
      for (let i = 0; i < data.length; i += 8192) {
        if (ws.bufferedAmount > 1024 * 1024) return ws.close()
        ws.send(
          JSON.stringify({ type: 'input', data: data.slice(i, i + 8192) }),
        )
      }
    })
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      resize()
      status('connected')
      term.focus()
    }
    ws.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) term.write(new Uint8Array(data))
    }
    ws.onclose = ws.onerror = () => status('failed')
    return () => {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
      input.dispose()
      observer.disconnect()
      term.dispose()
    }
  }, [url, status])
  return (
    <div
      ref={host}
      aria-label="终端输出"
      className="size-full min-w-0 overflow-hidden bg-black p-2 sm:p-3"
    />
  )
}
