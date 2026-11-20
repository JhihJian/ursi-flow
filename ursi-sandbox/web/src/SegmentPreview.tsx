import { useLayoutEffect, useRef, useState } from 'react'
import { Download, Play, X } from 'lucide-react'
import { Button, buttonVariants } from './shared/ui/button'
import { Input } from './shared/ui/input'
import { Select } from './shared/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './shared/ui/table'
import { PREVIEW_LIMIT, type PacketRow, type PcapPreview } from './pcap'
import type { PreviewMessage } from './pcap.worker'

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
    <section className="min-w-0 space-y-3" aria-label="报文明细">
      <h3 className="font-semibold">报文明细</h3>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          分段
          {segments <= 200 ? (
            <Select
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
              className="w-24"
              type="number"
              min={1}
              max={segments}
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
            />
          )}
          <span className="text-txt3">/ {segments}</span>
        </label>
        {valid && (
          <a
            href={url}
            download={`capture-${String(segment).padStart(6, '0')}.pcap`}
            className={buttonVariants({ variant: 'outline' })}
          >
            <Download />
            下载完整分段
          </a>
        )}
      </div>
      {valid ? (
        <Reader key={url} url={url} onAccessDenied={onAccessDenied} />
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
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {state.type === 'loading' ? (
          <Button
            onClick={() => {
              stop()
              setState({ type: 'cancelled' })
            }}
          >
            <X />
            取消预览
          </Button>
        ) : (
          <Button onClick={start}>
            <Play />
            {state.type === 'error' ? '重试预览' : '预览分段'}
          </Button>
        )}
        <span className="text-xs text-txt3">
          仅预览本段前 {PREVIEW_LIMIT} 条完整记录
        </span>
      </div>
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
      {state.type === 'ready' && <PacketList preview={state.preview} />}
    </div>
  )
}

function PacketList({ preview }: { preview: PcapPreview }) {
  const { rows, end, message } = preview
  const [address, setAddress] = useState(''),
    [protocol, setProtocol] = useState(''),
    [direction, setDirection] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const needle = address.trim().toLowerCase()
  const visible = rows.filter(
    (r) =>
      (!protocol || r.protocol === protocol) &&
      (!direction || r.direction === direction) &&
      (!needle || r.source.includes(needle) || r.destination.includes(needle)),
  )
  const detail = visible.find((r) => r.number === selected)
  return (
    <div className="min-w-0 space-y-3">
      {message && (
        <p role="alert" className="text-err">
          {message}
        </p>
      )}
      <p role="status" className="text-sm text-txt3">
        {end === 'eof' && !rows.length
          ? '空段，没有报文记录。'
          : `已预览 ${rows.length} 条完整记录。`}
        {end === 'limit' && '已达到预览上限，未继续读取。'}
      </p>
      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1">
              协议
              <Select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="">全部协议</option>
                {[...new Set(rows.map((r) => r.protocol))].sort().map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </label>
            <label className="grid gap-1">
              地址
              <Input
                type="search"
                placeholder="源或目的地址"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </label>
            <label className="grid gap-1">
              方向
              <Select
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="">全部方向</option>
                {[...new Set(rows.map((r) => r.direction))].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            </label>
            <span className="text-xs text-txt3" role="status">
              显示 {visible.length} / {rows.length} 条
            </span>
          </div>
          {detail && <PacketDetail row={detail} />}
          {visible.length === 0 ? (
            <p className="empty-state">没有匹配的预览记录。</p>
          ) : (
            <Table className="whitespace-nowrap">
              <TableHeader>
                <TableRow>
                  {[
                    '序号',
                    '时间（UTC）',
                    '接口索引',
                    '方向',
                    '源地址',
                    '目的地址',
                    '协议',
                    '捕获 / 原始（B）',
                  ].map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow
                    key={r.number}
                    onClick={() => setSelected(r.number)}
                    className={detail === r ? 'bg-elevated' : undefined}
                  >
                    <TableCell>
                      <Button
                        variant="link"
                        size="sm"
                        aria-label={`查看记录 #${r.number}`}
                        aria-pressed={detail === r}
                      >
                        #{r.number}
                      </Button>
                    </TableCell>
                    <TableCell>{r.time}</TableCell>
                    <TableCell>{r.ifindex ?? '未知'}</TableCell>
                    <TableCell>{r.direction}</TableCell>
                    <TableCell>{r.source || '未知'}</TableCell>
                    <TableCell>{r.destination || '未知'}</TableCell>
                    <TableCell>{r.protocol}</TableCell>
                    <TableCell>
                      {r.captured} / {r.original}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  )
}

function PacketDetail({ row: r }: { row: PacketRow }) {
  return (
    <div
      aria-live="polite"
      className="space-y-1 break-words border-l-2 border-accent pl-3 text-sm text-txt2"
    >
      <p className="font-semibold">
        记录 #{r.number} · {r.time}
      </p>
      <p>
        {r.protocol}　{r.source || '未知'} → {r.destination || '未知'}
        {r.ports && `　端口 ${r.ports[0]} → ${r.ports[1]}`}
      </p>
      <p>
        SLL2 接口索引 {r.ifindex ?? '未知'} · {r.direction}（包类型{' '}
        {r.packetType ?? '未知'}）· 文件偏移 {r.offset} B
      </p>
      <p>
        捕获长度 {r.captured} B · 原始长度 {r.original} B
        {r.captured < r.original && '（抓包时已截短）'}
      </p>
      {r.note && <p>{r.note}</p>}
    </div>
  )
}
