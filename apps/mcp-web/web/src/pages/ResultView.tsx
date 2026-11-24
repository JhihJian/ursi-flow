import { useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { DataTable } from '../ui/data-table'
import { Tabs } from '../ui/tabs'

/**
 * 工具结果动态渲染。优先 structuredContent，其次解析 content 里
 * 的 JSON 文本；找不到结构就退回原始展示。只认顶层形态：
 * 对象数组 → 表格，标量集合 → 键值行，嵌套值折叠。始终可切回原始 JSON。
 */

const cellLimit = 120

function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > cellLimit ? `${text.slice(0, cellLimit)}…` : text
}

function EmptyCell() {
  return <span className="text-txt3">—</span>
}

function cellOf(value: unknown) {
  if (value === null || value === undefined || value === '') return <EmptyCell />
  if (typeof value === 'string' && /^https?:\/\//.test(value))
    return <a className="break-all text-accent-2 underline-offset-2 hover:underline" href={value} target="_blank" rel="noreferrer">{value}</a>
  if (typeof value === 'object') return <span className="font-mono text-xs text-txt2">{summarize(value)}</span>
  return <span className="break-words">{typeof value === 'boolean' ? String(value) : String(value)}</span>
}

function ScalarRows({ record }: { record: Record<string, unknown> }) {
  const scalars = Object.entries(record).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  if (!scalars.length) return null
  return <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
    {scalars.map(([key, value]) => <div key={key} className="contents">
      <dt className="font-medium text-txt2">{key}</dt>
      <dd className="min-w-0 break-words">{cellOf(value)}</dd>
    </div>)}
  </dl>
}

function NestedValue({ label, value }: { label: string; value: unknown }) {
  return <details>
    <summary className="cursor-pointer font-medium text-accent-2">{label}</summary>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
  </details>
}

function RecordsTable({ label, rows }: { label: string; rows: Record<string, unknown>[] }) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row).filter(key => row[key] !== null && typeof row[key] !== 'object')))]
  const columns: ColumnDef<Record<string, unknown>>[] = keys.map(key => ({
    id: key,
    header: key,
    cell: ({ row }) => cellOf(row.original[key]),
  }))
  return <div className="min-w-0">
    <p className="text-xs text-txt3">{label} · {rows.length} 条</p>
    <DataTable label={label} columns={columns} data={rows} rowId={row => JSON.stringify(row).slice(0, 120)} />
  </div>
}

export function findRecordRows(value: unknown): { key: string; rows: Record<string, unknown>[] } | null {
  if (!value || typeof value !== 'object') return null
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && item.length > 0 && item.every(row => row && typeof row === 'object' && !Array.isArray(row)))
      return { key, rows: item as Record<string, unknown>[] }
  }
  return null
}

type Props = { output: Record<string, unknown> }

/** content 数组里的纯文本段（非 JSON 时按原文展示）。 */
function TextSegments({ output }: { output: Record<string, unknown> }) {
  const parts = (Array.isArray(output.content) ? output.content : [])
    .map(part => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, unknown>).text as string
      : null))
    .filter((text): text is string => text !== null && !looksLikeJson(text))
  return parts.length
    ? <>{parts.map((text, index) => <pre key={index} className="max-h-72 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs">{text}</pre>)}</>
    : null
}

/** 无 structuredContent 时，尝试解析首个 content 文本中的 JSON。 */
function contentJson(output: Record<string, unknown>): unknown {
  const part = (Array.isArray(output.content) ? output.content : [])
    .find(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string')
  const text = part ? (part as Record<string, unknown>).text as string : null
  if (!text || !looksLikeJson(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function TextFallback({ output }: { output: Record<string, unknown> }) {
  const hasText = Array.isArray(output.content) && output.content.some(part => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string')
  return hasText ? null : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs">{JSON.stringify(output, null, 2)}</pre>
}

export function ResultView({ output }: Props) {
  const [mode, setMode] = useState<'structured' | 'raw'>('structured')
  const structured = output.structuredContent ?? contentJson(output)
  const rows = mode === 'structured' ? findRecordRows(structured) : null
  const nested = mode === 'structured' && structured && typeof structured === 'object' && !Array.isArray(structured)
    ? Object.entries(structured as Record<string, unknown>).filter(([key, value]) => typeof value === 'object' && value !== null && (!rows || key !== rows.key))
    : []
  const isError = 'isError' in output && output.isError
  return <section className="grid gap-3 border border-line bg-surface p-3">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <span aria-hidden="true" className={isError ? 'text-err' : 'text-ok'}>{isError ? '✕' : '✓'}</span>
        {isError ? '工具返回错误' : '执行结果'}
      </h3>
      <Tabs label="结果查看方式" value={mode} onValue={setMode}
        items={[{ value: 'structured', title: '结构化' }, { value: 'raw', title: '原始 JSON' }]} />
    </div>
    {mode === 'raw' && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs">{JSON.stringify(output, null, 2)}</pre>}
    {mode === 'structured' && <div className="grid gap-3 text-sm">
      {rows && <RecordsTable label={rows.key} rows={rows.rows} />}
      {!!structured && typeof structured === 'object' && !Array.isArray(structured) && <ScalarRows record={structured as Record<string, unknown>} />}
      {nested.map(([key, value]) => <NestedValue key={key} label={key} value={value} />)}
      {(!structured || typeof structured !== 'object') && <TextSegments output={output} />}
      {(!structured || typeof structured !== 'object') && <TextFallback output={output} />}
    </div>}
  </section>
}
