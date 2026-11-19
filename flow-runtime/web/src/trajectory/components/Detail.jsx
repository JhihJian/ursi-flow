import React, { useEffect, useId, useRef, useState } from 'react'
import { Maximize2, Minimize2, WrapText, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDuration } from '../lib/parser.js'
import { CopyButton, JsonTree } from './JsonTree.jsx'
import tableCss from './reference/TrajectoryTable.module.css'
import './styles/detail.css'

const kindLabel = { user: 'User', message: 'Assistant', tool: 'Tool', compacted: 'Compacted' }
const kindClass = { user: tableCss.user, message: tableCss.assistantVioletBright, tool: tableCss.toolAmber, compacted: tableCss.compacted }
const usageFields = [['input', 'Input'], ['output', 'Output'], ['think', 'Reasoning'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write'], ['totalTokens', 'Total tokens']]
const formatChars = (value) => value < 1000 ? `${value} chars` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k chars`

export function previewText(value, limit = 12000) {
  if (value.length <= limit) return { text: value, hidden: 0 }
  const head = Math.floor(limit * 0.66)
  const hidden = value.length - limit
  return { text: `${value.slice(0, head)}\n\n… ${formatChars(hidden)} hidden …\n\n${value.slice(-(limit - head))}`, hidden }
}

export function detailTabs(kind) {
  return kind === 'tool' ? ['overview', 'input', 'output', 'timing', 'raw'] : kind === 'compacted' ? ['overview', 'raw'] : ['overview', 'preview', 'raw']
}

export function tabForKey(tabs, current, key) {
  const index = tabs.indexOf(current)
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs.at(-1)
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft') return tabs[(index + tabs.length - 1) % tabs.length]
  return null
}

export function TextOutput({ value = '', label, previewLimit = 12000, markdown = false }) {
  const [expanded, setExpanded] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [rendered, setRendered] = useState(markdown)
  const preview = previewText(value, previewLimit)
  const displayed = expanded ? value : preview.text
  return <div className="long-output detail-text-output" data-wrap={String(wrap)}>
    <div className="long-output-toolbar"><span className="long-output-meta">{label} · {value ? value.split('\n').length : 0} lines · {formatChars(value.length)}</span><div className="long-output-actions">
      {markdown && <button type="button" className="output-action" aria-pressed={!rendered} onClick={() => setRendered(!rendered)}>{rendered ? 'Source' : 'Markdown'}</button>}
      {(!markdown || !rendered) && <button type="button" className="output-action" onClick={() => setWrap(!wrap)} aria-pressed={wrap}><WrapText size={13} />{wrap ? 'Wrapped' : 'Wrap'}</button>}
      <CopyButton value={value} title={`Copy ${label.toLowerCase()}`} />
      {preview.hidden > 0 && <button type="button" className="output-action output-action-primary" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}{expanded ? 'Collapse' : 'Show full'}</button>}
    </div></div>
    {rendered ? <Markdown value={displayed} /> : <pre className="long-output-content">{displayed || '∅ Empty output'}</pre>}
    {preview.hidden > 0 && !expanded && <div className="long-output-note">Showing the beginning and end. {formatChars(preview.hidden)} hidden from view.</div>}
  </div>
}

function textChildren(children) {
  return React.Children.toArray(children).map((child) => typeof child === 'string' || typeof child === 'number' ? String(child) : React.isValidElement(child) ? textChildren(child.props.children) : '').join('')
}

function CodeBlock({ children }) {
  const value = textChildren(children)
  return <div className="detail-code-block"><div className="detail-code-toolbar"><CopyButton value={value} label="Copy code" /></div><pre>{children}</pre></div>
}

function Markdown({ value }) {
  return <div className={`${tableCss.markdownPreview} detail-markdown`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, img: ({ alt }) => <span className="detail-missing-image">Image reference{alt ? ` (${alt})` : ''}: embedded image data is not available here.</span> }}>{value}</ReactMarkdown></div>
}

function parseJson(value) {
  if (typeof value !== 'string') return { valid: value !== undefined, value }
  try { return { valid: true, value: JSON.parse(value) } } catch { return { valid: false, value } }
}

function decodeBlock(block) {
  if (!block || typeof block !== 'object') return { type: 'text', text: String(block ?? '') }
  if (typeof block.content === 'string') {
    const parsed = parseJson(block.content)
    if (parsed.valid && parsed.value?.type === block.type) return parsed.value
    if (block.type === 'text') return { ...block, text: block.content }
    if (block.type === 'thinking') return { ...block, thinking: block.content }
  }
  return block
}

export function contentBlocks(cell) {
  const rawContent = cell.kind === 'tool' ? cell.raw?.result?.message?.content : cell.raw?.message?.content
  if (Array.isArray(rawContent)) return rawContent.map(decodeBlock)
  if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }]
  const blocks = cell.kind === 'tool' ? cell.outputBlocks ?? cell.sourceBlocks?.filter((block) => block.type !== 'toolCall') : cell.sourceBlocks
  if (blocks?.length) return blocks.map(decodeBlock)
  const content = cell.kind === 'tool' ? cell.outputDetail ?? '' : cell.outputDetail ?? cell.inputDetail ?? ''
  return [...(cell.thinkingDetail ? [{ type: 'thinking', thinking: cell.thinkingDetail }] : []), ...(content ? [{ type: 'text', text: content }] : [])]
}

export function embeddedImageSource(block) {
  if (typeof block?.data !== 'string' || !block.data || typeof block.mimeType !== 'string') return null
  if (!/^image\/[a-z0-9.+-]+$/i.test(block.mimeType)) return null
  const data = block.data.replace(/\s/g, '')
  return /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:${block.mimeType};base64,${data}` : null
}

function EmbeddedImage({ block, index }) {
  const [failed, setFailed] = useState(false)
  const src = embeddedImageSource(block)
  return <figure className="detail-image">{src && !failed ? <img src={src} alt={block.alt || `Embedded image ${index + 1}`} loading="lazy" onError={() => setFailed(true)} /> : <p className="detail-empty">{failed ? 'The embedded image could not be decoded.' : 'Image reference: embedded image data or a supported MIME type is missing from this session.'}</p>}<figcaption>{block.mimeType || 'Image'}{block.path || block.url ? ` · ${block.path || block.url}` : ''}</figcaption></figure>
}

function Thinking({ value, open, onToggle }) {
  const id = useId()
  return <div className="detail-thinking"><button type="button" className="detail-thinking-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}><span aria-hidden="true">{open ? '▾' : '▸'}</span> Thinking</button><div id={id} hidden={!open}>{open && <TextOutput value={value} label="Thinking" markdown />}</div></div>
}

function StructuredOutput({ value, label }) {
  const parsed = parseJson(value)
  return parsed.valid ? <JsonTree value={parsed.value} label={label} /> : <TextOutput value={String(value ?? '')} label={label} />
}

function MessageContent({ cell, thinkingOpen, onThinkingToggle }) {
  const blocks = contentBlocks(cell).filter((block) => block.type !== 'toolCall')
  return blocks.length ? blocks.map((block, index) => {
    if (block.type === 'thinking') return <Thinking key={index} value={block.thinking ?? ''} open={thinkingOpen} onToggle={onThinkingToggle} />
    if (block.type === 'image' || block.type === 'image_url') return <EmbeddedImage key={index} block={block} index={index} />
    if (block.type === 'text') return cell.kind === 'tool' ? <StructuredOutput key={index} value={block.text ?? ''} label={cell.isError ? 'Error output' : 'Output'} /> : <TextOutput key={index} value={block.text ?? ''} label={cell.kind === 'user' ? 'Input' : 'Output'} markdown />
    return <JsonTree key={index} value={block} label={block.type || 'Content block'} />
  }) : <p className="detail-empty">{cell.kind === 'tool' ? '∅ Empty output' : 'No text or image content recorded.'}</p>
}

function sameCell(a, b) { return a === b || (a.recordId != null && a.recordId === b.recordId) }

export function relatedRecords(cell, records) {
  const selected = records.find((record) => sameCell(record.cell, cell))
  const assistantId = selected?.assistantId
  const calls = cell.kind === 'message' && assistantId != null ? records.filter((record) => record.cell.kind === 'tool' && record.assistantId === assistantId) : []
  const parent = cell.kind === 'tool' ? records.find((record) => record.cell.kind === 'message' && ((assistantId != null && record.assistantId === assistantId) || (cell.raw?.assistant?.id != null && record.cell.recordId === cell.raw.assistant.id))) : undefined
  return { calls, parent }
}

export function usageOf(cell) {
  const raw = cell.raw?.message?.usage
  return Object.fromEntries(usageFields.flatMap(([key]) => {
    const value = cell[key] ?? raw?.[key === 'think' ? 'reasoning' : key]
    return Number.isFinite(value) ? [[key, value]] : []
  }))
}

export function cumulativeUsage(cell, records) {
  const index = records.findIndex((record) => sameCell(record.cell, cell))
  if (index < 0) return null
  const totals = {}
  for (const record of records.slice(0, index)) {
    for (const [key, value] of Object.entries(usageOf(record.cell))) totals[key] = (totals[key] ?? 0) + value
  }
  return totals
}

function UsageRows({ usage }) {
  return usage && Object.keys(usage).length ? <dl className={tableCss.overview}>{usageFields.filter(([key]) => usage[key] !== undefined).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{usage[key]}</dd></div>)}</dl> : <p className="detail-empty">No usage recorded.</p>
}

function Usage({ cell, records }) {
  const cumulative = cumulativeUsage(cell, records)
  return <div className={tableCss.usagePanel}><section className={tableCss.usageGroup}><h4 className={tableCss.usageHeading}>This record</h4><UsageRows usage={usageOf(cell)} /></section><section className={tableCss.usageGroup}><h4 className={tableCss.usageHeading}>Before this record</h4>{cumulative === null ? <p className="detail-empty">Session records are unavailable.</p> : <UsageRows usage={cumulative} />}</section></div>
}

function Timestamp({ value }) {
  const [unix, setUnix] = useState(false)
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return <dd>Not recorded</dd>
  return <dd><button type="button" className={tableCss.timestampToggle} aria-label={unix ? 'Show local time' : 'Show Unix timestamp'} title={unix ? 'Show local time' : 'Show Unix timestamp'} onClick={() => setUnix(!unix)}>{unix ? `${(value / 1000).toFixed(3)} Unix seconds` : new Date(value).toLocaleString()}</button></dd>
}

function Timing({ cell }) {
  const result = cell.raw?.result
  const completed = result ? Date.parse(result.timestamp ?? '') : NaN
  const durationMs = result?.message?.durationMs ?? cell.raw?.message?.durationMs
  const recorded = Number.isFinite(durationMs)
  return <><dl className={tableCss.overview}><div><dt>{cell.kind === 'tool' && !cell.raw?.call ? 'Result time' : 'Record time'}</dt><Timestamp value={cell.startedAt} /></div>{Number.isFinite(completed) && <div><dt>Result time</dt><Timestamp value={completed} /></div>}<div><dt>{recorded ? 'Recorded duration' : cell.kind === 'tool' && Number.isFinite(cell.timeSeconds) ? 'Call-to-result interval' : 'Duration'}</dt><dd>{formatDuration(recorded ? durationMs / 1000 : cell.timeSeconds)}</dd></div></dl>{!recorded && <p className="detail-empty">{cell.kind === 'tool' && Number.isFinite(cell.timeSeconds) ? 'This interval uses the assistant and result timestamps. Tool execution timing is not recorded separately.' : 'No duration timing was recorded for this record.'}</p>}<p className="detail-empty">First-token timing and generation speed are not recorded in this session.</p></>
}

function Section({ title, children }) {
  return <section className={tableCss.overviewSection}><h3 className={tableCss.overviewHeading}>{title}</h3><div className={tableCss.overviewPreview}>{children}</div></section>
}

function Navigation({ cell, records, onNavigate }) {
  const { calls, parent } = relatedRecords(cell, records)
  if (cell.kind === 'tool') return <Section title="Parent assistant">{parent ? <button className="detail-navigate" type="button" disabled={!onNavigate} onClick={() => onNavigate?.(parent.cell)}>← Assistant · {parent.cell.text}</button> : <p className="detail-empty">No parent assistant record is available.</p>}</Section>
  return calls.length > 0 ? <Section title={`Tool calls (${calls.length})`}><ul className="detail-call-list">{calls.map(({ cell: call }, index) => <li key={call.recordId || index}><button type="button" className="detail-navigate" disabled={!onNavigate} onClick={() => onNavigate?.(call)}><strong>{call.toolName || call.text}</strong><span>{call.callId}</span><span>{call.isError ? 'Error' : call.raw?.result ? 'Result recorded' : 'No result recorded'} →</span></button></li>)}</ul></Section> : null
}

export function Detail({ cell, onClose, onNavigate, records = [] }) {
  const [tab, setTab] = useState('overview')
  const [thinkingOpen, setThinkingOpen] = useState(true)
  useEffect(() => { setThinkingOpen(true) }, [cell.recordId])
  const tabs = detailTabs(cell.kind)
  const active = tabs.includes(tab) ? tab : 'overview'
  const closeRef = useRef(null)
  const id = useId()
  useEffect(() => { if (tab !== active) setTab(active) }, [tab, active])
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [cell.recordId])
  const hasResult = Boolean(cell.raw?.result) || cell.outputDetail !== undefined || Boolean(cell.outputBlocks?.length)
  const content = <MessageContent cell={cell} thinkingOpen={thinkingOpen} onThinkingToggle={() => setThinkingOpen(open => !open)} />
  const toolOutput = hasResult ? content : <p className="tool-empty-output">The session does not contain a result for this call.</p>
  const toolInput = cell.raw?.call?.arguments !== undefined || cell.inputDetail !== undefined ? <StructuredOutput value={cell.raw?.call?.arguments !== undefined ? cell.raw.call.arguments : cell.inputDetail} label="Arguments" /> : <p className="detail-empty">No arguments recorded.</p>
  return <aside className={`${tableCss.details} record-details`} aria-label="Record details" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className={tableCss.detailsHeader}><div className={tableCss.detailsTitle}><span className={`${tableCss.kindTag} ${kindClass[cell.kind] || ''}`}>{kindLabel[cell.kind] || cell.kind}</span><span className={tableCss.detailsLocation}>{cell.text}</span></div><button ref={closeRef} className={tableCss.close} type="button" aria-label="Close details" title="Close details" onClick={onClose}><X size={14} /></button></div>
    <div className={tableCss.detailTabs} role="tablist" aria-label="Record detail tabs" onKeyDown={(event) => {
      const next = tabForKey(tabs, active, event.key)
      if (!next) return
      event.preventDefault()
      setTab(next)
      event.currentTarget.querySelectorAll('[role="tab"]')[tabs.indexOf(next)]?.focus()
    }}>{tabs.map((item) => <button key={item} id={`${id}-tab-${item}`} aria-controls={`${id}-panel`} type="button" role="tab" aria-selected={active === item} tabIndex={active === item ? 0 : -1} className={active === item ? `${tableCss.detailTab} ${tableCss.detailTabActive}` : tableCss.detailTab} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} tabIndex={0} className={`${tableCss.detailBody} ${active === 'overview' ? tableCss.detailBodySummary : ''} detail-scroll`}>
      <div key={cell.recordId ?? cell.index ?? 'record'} className="detail-record-content">
        {active === 'raw' && <JsonTree value={cell.raw ?? null} label="Raw JSON" />}
        {active === 'input' && toolInput}
        {active === 'output' && toolOutput}
        {active === 'timing' && <Timing cell={cell} />}
        {active === 'preview' && <>{content}<div className="detail-sections"><Navigation cell={cell} records={records} onNavigate={onNavigate} /></div></>}
        {active === 'overview' && <>
          <dl className={`${tableCss.overview} detail-metadata`}><div><dt>Record</dt><dd>{cell.recordId || '—'}</dd></div><div><dt>Time</dt><Timestamp value={cell.startedAt} /></div><div><dt>Duration</dt><dd>{formatDuration(cell.timeSeconds)}</dd></div>{cell.callId && <div><dt>Call ID</dt><dd>{cell.callId}</dd></div>}{cell.toolName && <div><dt>Tool</dt><dd>{cell.toolName}</dd></div>}{cell.raw?.message?.model && <div><dt>Model</dt><dd>{cell.raw.message.model}</dd></div>}</dl>
          <div className={`${tableCss.overviewSections} detail-sections`}>
            {cell.kind === 'tool' ? <><div className={`tool-status tool-status-${cell.isError ? 'error' : hasResult ? 'complete' : 'missing'}`}><span className="tool-status-dot" />{cell.isError ? 'Error' : hasResult ? 'Result recorded' : 'No result recorded'}</div><Section title="Arguments">{toolInput}</Section><Section title="Output">{toolOutput}</Section></> : <Section title={cell.kind === 'compacted' ? 'Summary' : cell.kind === 'user' ? 'Input' : 'Output'}>{content}</Section>}
            <Navigation cell={cell} records={records} onNavigate={onNavigate} />
            {(cell.kind === 'message' || Object.keys(usageOf(cell)).length > 0) && <Section title="Usage"><Usage cell={cell} records={records} /></Section>}
          </div>
        </>}
      </div>
    </div>
  </aside>
}
