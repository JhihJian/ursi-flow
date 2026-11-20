import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalSurface({ url, status }: {
  url?: string
  status: (state: 'connecting' | 'connected' | 'failed') => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current!
    const term = new Terminal({ disableStdin: !url, fontSize: 13, scrollback: 2000, allowProposedApi: false })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    const ws = url ? new WebSocket(url) : null
    const resize = () => {
      fit.fit()
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: Math.min(500, term.cols), rows: Math.min(500, term.rows) }))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    const input = term.onData((data) => {
      if (ws?.readyState !== WebSocket.OPEN) return
      // Include room for UTF-8 and JSON escaping in the server frame limit.
      for (let i = 0; i < data.length; i += 8192) {
        if (ws.bufferedAmount > 1024 * 1024) return ws.close()
        ws.send(JSON.stringify({ type: 'input', data: data.slice(i, i + 8192) }))
      }
    })
    if (ws) {
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { resize(); status('connected'); term.focus() }
      ws.onmessage = ({ data }) => { if (data instanceof ArrayBuffer) term.write(new Uint8Array(data)) }
      ws.onclose = ws.onerror = () => status('failed')
    } else {
      term.writeln('[demo] agent@release-review:/ursi/workspace$ ls')
      term.writeln('README.md  index.html')
    }
    return () => {
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        ws.close()
      }
      input.dispose()
      observer.disconnect()
      term.dispose()
    }
  }, [url, status])
  return <div ref={host} aria-label="终端输出" className="h-80 min-w-0 overflow-hidden rounded bg-black p-2" />
}
