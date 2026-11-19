import React, { useEffect, useRef, useState } from 'react'
import { Copy, WrapText } from 'lucide-react'
import './styles/detail.css'

export async function copyText(value) {
  if (globalThis.navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return } catch { /* Try the local-page fallback. */ }
  }
  if (typeof document === 'undefined') throw new Error('Clipboard unavailable')
  const previous = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0'
  document.body.append(textarea)
  try {
    textarea.select()
    if (!document.execCommand?.('copy')) throw new Error('Clipboard unavailable')
  } finally {
    textarea.remove()
    previous?.focus({ preventScroll: true })
  }
}

export function CopyButton({ value, label = 'Copy', title = label }) {
  const [status, setStatus] = useState('')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try { await copyText(value); setStatus('Copied') } catch { setStatus('Copy failed') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setStatus(''), 1800)
  }
  return <button type="button" className="output-action" onClick={copy} title={title} aria-label={title}><Copy size={13} /><span aria-live="polite">{status || label}</span></button>
}

export function jsonPath(parent, key, array = false) {
  return array ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function jsonText(value, pretty = true) {
  return JSON.stringify(value, null, pretty ? 2 : undefined) ?? 'undefined'
}

function JsonNode({ value, name, path, depth }) {
  const [open, setOpen] = useState(depth === 0)
  const [full, setFull] = useState(false)
  const [all, setAll] = useState(false)
  const branch = value !== null && typeof value === 'object'
  const entries = branch ? Object.entries(value) : []
  const text = typeof value === 'string' ? value : jsonText(value)
  const long = !branch && text.length > 1500
  const shown = long && !full ? `${text.slice(0, 1000)} … ${text.length - 1500} chars hidden … ${text.slice(-500)}` : text
  return <div className="json-node" data-json-path={path}>
    <div className="json-node-row">
      {branch && <button type="button" className="json-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${path}`}>{open ? '▾' : '▸'}</button>}
      {name !== undefined && <span className="json-key">{JSON.stringify(name)}: </span>}
      {branch ? <span className="json-summary">{Array.isArray(value) ? `[${entries.length} items]` : `{${entries.length} keys}`}</span> : <span className={`json-value json-${value === null ? 'null' : typeof value}`}>{typeof value === 'string' ? `"${shown}"` : shown}</span>}
      {long && <button type="button" className="output-action" aria-expanded={full} onClick={() => setFull(!full)}>{full ? 'Collapse string' : 'Show full string'}</button>}
      <span className="json-node-actions">
        <CopyButton value={typeof value === 'string' ? value : jsonText(value, false)} label="Value" title={`Copy value at ${path}`} />
        <CopyButton value={path} label="Path" title={`Copy path ${path}`} />
        <CopyButton value={jsonText(value)} label="JSON" title={`Copy JSON at ${path}`} />
      </span>
    </div>
    {branch && open && <div className="json-children">{(all ? entries : entries.slice(0, 100)).map(([key, child]) => <JsonNode key={key} name={key} value={child} depth={depth + 1} path={jsonPath(path, key, Array.isArray(value))} />)}{entries.length > 100 && <button type="button" className="output-action" onClick={() => setAll(!all)}>{all ? 'Show first 100' : `Show all ${entries.length} items`}</button>}</div>}
  </div>
}

export function JsonTree({ value, label = 'JSON' }) {
  const [wrap, setWrap] = useState(true)
  return <div className="detail-json" data-wrap={String(wrap)} role="group" aria-label={label}>
    <div className="long-output-toolbar"><span className="long-output-meta">{label}</span><div className="long-output-actions"><button type="button" className="output-action" onClick={() => setWrap(!wrap)} aria-pressed={wrap}><WrapText size={13} />{wrap ? 'Wrapped' : 'Wrap'}</button><CopyButton value={jsonText(value)} label="Copy JSON" title={`Copy ${label}`} /></div></div>
    <div className="json-tree-content"><JsonNode value={value} path="$" depth={0} /></div>
  </div>
}
