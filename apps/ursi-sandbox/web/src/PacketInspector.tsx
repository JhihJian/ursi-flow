import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PacketRow, PcapPreview } from './pcap'
import { Input } from './shared/ui/input'
import { Select } from './shared/ui/select'
import './packet-inspector.css'

type Field = PacketRow['layers'][number]['fields'][number]
const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, '0')
const covers = (field: Field, offset: number) =>
  offset >= field.start && offset < field.start + field.length

function navigate(event: KeyboardEvent, buttons: HTMLButtonElement[]) {
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return
  const next = {
    ArrowUp: index - 1,
    ArrowDown: index + 1,
    Home: 0,
    End: buttons.length - 1,
  }[event.key]
  if (next === undefined) return
  event.preventDefault()
  const target = buttons[Math.max(0, Math.min(next, buttons.length - 1))]
  target.focus()
  target.click()
}

export function PacketInspector({
  preview: { rows, end, message },
}: {
  preview: PcapPreview
}) {
  const [address, setAddress] = useState('')
  const [protocol, setProtocol] = useState('')
  const [direction, setDirection] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0
  }, [protocol, address, direction])
  const needle = address.trim().toLowerCase()
  const visible = rows.filter(
    (r) =>
      (!protocol || r.protocol === protocol) &&
      (!direction || r.direction === direction) &&
      (!needle ||
        [r.source, r.destination].some((a) =>
          a.toLowerCase().includes(needle),
        )),
  )
  const current = visible.find((r) => r.number === selected) ?? visible[0]
  return (
    <div className="pkt-workspace">
      {message && (
        <p className="text-sbx-err" role="alert">
          {message}
        </p>
      )}
      {!rows.length ? (
        <p role="status">
          {end === 'eof' ? '空段，没有报文记录。' : '已预览 0 条完整记录。'}
        </p>
      ) : (
        <>
          <div className="pkt-filters">
            <label>
              协议
              <Select
                value={protocol}
                onChange={(e) => {
                  setProtocol(e.target.value)
                  setSelected(null)
                }}
              >
                <option value="">全部协议</option>
                {[...new Set(rows.map((r) => r.protocol))].sort().map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </label>
            <label>
              地址
              <Input
                type="search"
                placeholder="源或目的地址"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setSelected(null)
                }}
              />
            </label>
            <label>
              方向
              <Select
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value)
                  setSelected(null)
                }}
              >
                <option value="">全部方向</option>
                {[...new Set(rows.map((r) => r.direction))].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            </label>
            <p role="status">
              显示 {visible.length} / {rows.length} 条
              {end === 'limit' && ' · 已达到预览上限，未继续读取。'}
            </p>
          </div>
          {!current ? (
            <p className="pkt-empty">没有匹配的预览记录。</p>
          ) : (
            <>
              <div className="pkt-list" ref={list}>
                <table
                  aria-label="报文列表"
                  onKeyDown={(e) =>
                    navigate(
                      e,
                      Array.from(e.currentTarget.querySelectorAll('button')),
                    )
                  }
                >
                  <thead>
                    <tr>
                      {[
                        '序号',
                        '相对时间 (s)',
                        '源端点',
                        '目的端点',
                        '协议',
                        '方向',
                        '捕获 / 原始 (B)',
                        '摘要',
                      ].map((h) => (
                        <th scope="col" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr
                        key={row.number}
                        data-current={row === current}
                        onClick={(e) => {
                          setSelected(row.number)
                          e.currentTarget
                            .querySelector('button')
                            ?.focus({ preventScroll: true })
                        }}
                      >
                        <td>
                          <button
                            type="button"
                            aria-label={`查看记录 #${row.number}`}
                            aria-pressed={row === current}
                            tabIndex={row === current ? 0 : -1}
                          >
                            #{row.number}
                          </button>
                        </td>
                        <td title={row.time}>
                          {row.relativeTime.toFixed(
                            /\.\d{9}Z$/.test(row.time) ? 9 : 6,
                          )}
                        </td>
                        {[row.source, row.destination].map((address, i) => {
                          const endpoint = !address
                            ? '未知'
                            : row.ports
                              ? `${address.includes(':') ? `[${address}]` : address}:${row.ports[i]}`
                              : address
                          return (
                            <td key={i} title={endpoint}>
                              {endpoint}
                            </td>
                          )
                        })}
                        <td>{row.protocol}</td>
                        <td>{row.direction}</td>
                        <td>
                          {row.captured} / {row.original}
                        </td>
                        <td title={row.summary}>{row.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <PacketDetail key={current.number} row={current} />
            </>
          )}
        </>
      )}
    </div>
  )
}

function PacketDetail({ row }: { row: PacketRow }) {
  const [field, setField] = useState<Field | undefined>(
    row.layers[0]?.fields[0],
  )
  const [byte, setByte] = useState<number | null>(null)
  const tree = useRef<HTMLDivElement>(null)
  function selectByte(offset: number) {
    // Nested field ranges can overlap. Prefer the most specific decoded field.
    let match: Field | undefined
    for (const layer of row.layers)
      for (const f of layer.fields) {
        if (covers(f, offset) && (!match || f.length < match.length)) match = f
      }
    setField(match)
    setByte(offset)
    if (match && tree.current) {
      const layer = row.layers.findIndex((layer) =>
        layer.fields.includes(match!),
      )
      const group = tree.current.querySelectorAll('details')[layer]
      group.open = true
      const target =
        group.querySelectorAll('button')[
          row.layers[layer].fields.indexOf(match)
        ]
      reveal(tree.current, target)
    }
  }
  return (
    <>
      <div className="pkt-frame">
        <strong aria-live="polite">记录 #{row.number}</strong>
        <span>{row.time}</span>
        <span>
          SLL2 接口索引 {row.ifindex ?? '未知'} · {row.direction}（包类型{' '}
          {row.packetType ?? '未知'}）
        </span>
        <span>文件偏移 {row.offset} B</span>
        <span>
          捕获 {row.captured} / 原始 {row.original} B
          {row.captured < row.original && '（抓包时已截短）'}
        </span>
        {row.note && <span className="text-sbx-warn">{row.note}</span>}
      </div>
      <div className="pkt-panes">
        <section aria-label="协议分层">
          <h4>协议分层</h4>
          <div
            className="pkt-scroll"
            ref={tree}
            onKeyDown={(e) =>
              navigate(
                e,
                Array.from(
                  e.currentTarget.querySelectorAll('details[open] button'),
                ),
              )
            }
          >
            {row.layers.map((layer, index) => (
              <details key={index} open>
                <summary>{layer.name}</summary>
                {layer.fields.map((f, i) => (
                  <button
                    key={i}
                    className="pkt-field"
                    type="button"
                    aria-pressed={field === f}
                    onClick={() => {
                      setField(f)
                      setByte(null)
                    }}
                  >
                    <span>{f.label}</span>
                    <span>{f.value}</span>
                  </button>
                ))}
              </details>
            ))}
            {!row.layers.length && (
              <p className="pkt-empty">没有可解析的协议字段。</p>
            )}
          </div>
        </section>
        <BytePane
          bytes={row.bytes}
          captured={row.captured}
          field={field}
          byte={byte}
          selectByte={selectByte}
        />
      </div>
    </>
  )
}

// Reveal only inside the pane; inspecting a field must not scroll the whole page.
function reveal(pane: HTMLElement, item: HTMLElement) {
  const box = pane.getBoundingClientRect(),
    target = item.getBoundingClientRect()
  if (target.top < box.top) pane.scrollTop += target.top - box.top
  else if (target.bottom > box.bottom)
    pane.scrollTop += target.bottom - box.bottom
}

function BytePane({
  bytes,
  captured,
  field,
  byte,
  selectByte,
}: {
  bytes: Uint8Array
  captured: number
  field?: Field
  byte: number | null
  selectByte: (offset: number) => void
}) {
  const pane = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(8)
  useLayoutEffect(() => {
    const el = pane.current!
    const measure = () => setWidth(el.clientWidth >= 540 ? 16 : 8)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (byte !== null || !field || !field.length) return
    const line = pane.current?.children[Math.floor(field.start / width)]
    if (line instanceof HTMLElement) reveal(pane.current!, line)
  }, [field, width, byte])
  const length = Math.min(bytes.length, 512)
  const selected = (offset: number) =>
    field ? covers(field, offset) : byte === offset
  return (
    <section className="pkt-bytes" aria-label="帧字节">
      <h4>
        帧字节{' '}
        <span>
          Hex / ASCII · {length} / {captured} B
        </span>
      </h4>
      <div
        className="pkt-scroll pkt-dump"
        ref={pane}
        onClick={(e) => {
          const offset = (e.target as HTMLElement).dataset.byte
          if (offset !== undefined) selectByte(Number(offset))
        }}
      >
        {Array.from({ length: Math.ceil(length / width) }, (_, line) => {
          const start = line * width,
            chunk = bytes.subarray(start, Math.min(start + width, length))
          const cells = (ascii: boolean) =>
            Array.from(chunk, (b, i) => (
              <span
                key={i}
                data-byte={start + i}
                data-selected={selected(start + i)}
              >
                {ascii
                  ? b >= 32 && b < 127
                    ? String.fromCharCode(b)
                    : '.'
                  : hex(b, 2)}
              </span>
            ))
          return (
            <div className="pkt-line" key={start}>
              <span className="pkt-offset">{hex(start, 4)}</span>
              <code className="pkt-hex" style={{ width: `${width * 3}ch` }}>
                {cells(false)}
              </code>
              <code className="pkt-ascii">{cells(true)}</code>
            </div>
          )
        })}
        {!length && <p className="pkt-empty">没有捕获字节。</p>}
      </div>
      {field && (
        <p className="pkt-range">
          {field.label} · 帧偏移 {field.start} · {field.length} B
          {field.start + field.length > length && '（超出字节预览范围）'}
        </p>
      )}
    </section>
  )
}
