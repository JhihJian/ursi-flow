import { useLayoutEffect, useRef, useState } from 'react'
import { Download, Play, X } from 'lucide-react'
import { Button, buttonVariants } from './shared/ui/button'
import { Input } from './shared/ui/input'
import { Select } from './shared/ui/select'
import { PREVIEW_LIMIT } from './pcap'
import type { PreviewMessage } from './pcap.worker'
import { PacketInspector } from './PacketInspector'

type Props = { base: string; segments: number; onAccessDenied: () => void }
type State = { type: 'idle' | 'loading' | 'cancelled' } | PreviewMessage

export function SegmentPreview(props: Props) {
  if (!Number.isSafeInteger(props.segments) || props.segments < 1)
    return <p className="empty-state">暂无可用分段。</p>
  return <SegmentPicker key={props.base} {...props} />
}

function SegmentPicker({ base, segments, onAccessDenied }: Props) {
  const [selection, setSelection] = useState('1')
  const segment = Number(selection)
  const valid = Number.isInteger(segment) && segment >= 1 && segment <= segments
  const url = `${base}/segments/${segment}`
  return (
    <section
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5"
      aria-label="报文明细"
    >
      <h3 className="mr-2 text-sm font-semibold">报文明细</h3>
      <label className="flex items-center gap-1.5 text-xs">
        分段
        {segments <= 200 ? (
          <Select
            className="h-7 py-0 text-xs"
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
          >
            {Array.from({ length: segments }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            className="h-7 w-24 text-xs"
            type="number"
            min={1}
            max={segments}
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
          />
        )}
        <span className="text-txt3">/ {segments}</span>
      </label>
      {valid ? (
        <>
          <a
            href={url}
            download={`capture-${String(segment).padStart(6, '0')}.pcap`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Download />
            下载完整分段
          </a>
          <Reader key={url} url={url} onAccessDenied={onAccessDenied} />
        </>
      ) : (
        <p role="status">请选择有效的分段编号。</p>
      )}
    </section>
  )
}

function Reader({
  url,
  onAccessDenied,
}: {
  url: string
  onAccessDenied: () => void
}) {
  const [state, setState] = useState<State>({ type: 'idle' })
  const active = useRef<Worker | null>(null)
  const denied = useRef(onAccessDenied)
  useLayoutEffect(() => {
    denied.current = onAccessDenied
  }, [onAccessDenied])
  function stop() {
    active.current?.terminate()
    active.current = null
  }
  useLayoutEffect(() => stop, [])
  function start() {
    stop()
    setState({ type: 'loading' })
    try {
      const worker = new Worker(new URL('./pcap.worker.ts', import.meta.url), {
        type: 'module',
      })
      active.current = worker
      worker.onmessage = ({ data }: MessageEvent<PreviewMessage>) => {
        if (active.current !== worker) return
        stop()
        setState(data)
        if (data.type === 'denied') denied.current()
      }
      worker.onerror = () => {
        if (active.current !== worker) return
        stop()
        setState({ type: 'error', message: '预览线程运行失败。' })
      }
      // Relative fetch URLs in a bundled worker resolve against the asset directory.
      worker.postMessage(new URL(url, document.baseURI).href)
    } catch {
      stop()
      setState({ type: 'error', message: '无法启动分段预览。' })
    }
  }
  return (
    <>
      {state.type === 'loading' ? (
        <Button
          size="sm"
          onClick={() => {
            stop()
            setState({ type: 'cancelled' })
          }}
        >
          <X />
          取消预览
        </Button>
      ) : (
        <Button size="sm" onClick={start}>
          <Play />
          {state.type === 'error' ? '重试预览' : '预览分段'}
        </Button>
      )}
      <span className="text-xs text-txt3">
        仅预览本段前 {PREVIEW_LIMIT} 条完整记录
      </span>
      {state.type === 'loading' && <p role="status">正在读取分段…</p>}
      {state.type === 'cancelled' && <p role="status">已取消预览。</p>}
      {state.type === 'error' && (
        <p className="text-err" role="alert">
          {state.message}
        </p>
      )}
      {state.type === 'denied' && (
        <p className="text-err" role="alert">
          无权读取分段。
        </p>
      )}
      {state.type === 'ready' && <PacketInspector preview={state.preview} />}
    </>
  )
}
