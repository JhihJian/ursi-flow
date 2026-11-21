import { useState } from 'react'
import { fetchCatalog, invoke, readResource, saveSettings, type CatalogEntry, type CatalogKind, type McpServer, type McpSettings } from '@/shared/api/mcp'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { DataTable } from '@/shared/ui/data-table'
import { Switch } from '@/shared/ui/switch'
import type { ColumnDef } from '@tanstack/react-table'
import { ResourceState } from '@/shared/ui/resource-state'

type Props = { server: McpServer; settings: McpSettings; saved: (s: McpSettings) => void }
const titles = { tools: '工具', prompts: '提示词', templates: '资源模板' }
const code = 'max-h-64 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs'

export function OperationsPanel(props: Props & { kind: CatalogKind }) {
  const { kind, server } = props
  const list = useResource(signal => fetchCatalog(server.id, kind, signal), [])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const items = list.data.filter(x => `${x.name} ${x.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const key = (x: CatalogEntry) => x.uriTemplate ?? x.name
  const item = items.find(x => key(x) === selected) ?? (kind === 'tools' ? undefined : items[0])
  const permission = useMutation()
  const columns: ColumnDef<CatalogEntry>[] = [
    { id: 'name', header: '名称', cell: ({ row: { original: x } }) => <button className="break-all text-left font-medium text-accent-2" aria-pressed={key(x) === selected} onClick={() => setSelected(key(x))}>{x.name}</button> },
    { accessorKey: 'description', header: '说明', cell: ({ row }) => <span className="line-clamp-2 text-txt2">{row.original.description || '未提供'}</span> },
  ]
  if (kind === 'tools') columns.push({ id: 'permission', header: '允许调用', cell: ({ row: { original: x } }) => <Switch aria-label={`允许调用 ${x.name}`} checked={props.settings.allowedTools.includes(x.name)} disabled={permission.busy} onCheckedChange={on => {
    const allowedTools = on ? [...props.settings.allowedTools, x.name] : props.settings.allowedTools.filter(n => n !== x.name)
    void permission.run(signal => saveSettings(server.id, { ...props.settings, allowedTools }, signal), props.saved)
  }} /> })
  return <section className="scroll-area grid min-h-0 content-start gap-3 overflow-auto py-3">
    <div className="flex items-center justify-between"><h2>{titles[kind]}目录 · {list.data.length}</h2><Button size="sm" icon="refresh" onClick={list.reload}>刷新目录</Button></div>
    {list.loading || list.error || !list.data.length ? <ResourceState loading={list.loading} error={list.error} empty onRetry={list.reload} title={list.error ? undefined : '目录为空'} /> : <>
      <Input aria-label="搜索目录" placeholder="搜索名称或说明" value={search} onChange={e => setSearch(e.target.value)} />
      {items.length ? <DataTable key={search} label={`${titles[kind]}目录`} columns={columns} data={items} rowId={key} selected={item && key(item)} /> : <p>没有匹配项</p>}
      {permission.error && <p role="alert">{permission.error}</p>}
      {item && <Entry key={key(item)} {...props} item={item} saving={permission.busy} />}
    </>}
  </section>
}

function Entry({ server, settings, item, kind, saving }: Props & { item: CatalogEntry; kind: CatalogKind; saving: boolean }) {
  const [args, setArgs] = useState('{}')
  const [uri, setUri] = useState(item.uriTemplate ?? '')
  const [output, setOutput] = useState<Record<string, unknown> | null>(null)
  const execution = useMutation()
  const allowed = settings.allowedTools.includes(item.name)
  async function run(signal: AbortSignal) {
    setOutput(null)
    if (kind === 'templates') return readResource(server.id, uri, signal)
    let input: unknown
    try { input = JSON.parse(args) } catch { throw Error('参数不是合法 JSON') }
    if (!input || Array.isArray(input) || typeof input !== 'object') throw Error('参数须为 JSON 对象')
    if (kind === 'tools' && !await confirmAction({ title: `调用 ${item.name}？`, description: `将向 ${server.url} 提交当前参数。此操作可能修改远端数据。`, confirmLabel: '确认调用', danger: true })) return null
    if (signal.aborted) return null
    return invoke(server.id, kind, item.name, input, signal)
  }
  return <div className="grid min-w-0 gap-3 text-sm">
    {item.description && <p className="whitespace-pre-wrap break-words">{item.description}</p>}
    {kind === 'templates' ? <label>具体资源 URI<Input value={uri} onChange={e => setUri(e.target.value)} /></label> : <>
      <details><summary>参数定义</summary><pre className={code}>{JSON.stringify(item.inputSchema ?? item.arguments ?? [], null, 2)}</pre></details>
      <label>调用参数（JSON 对象）<textarea className="input block w-full font-mono" rows={4} value={args} onChange={e => setArgs(e.target.value)} /></label>
    </>}
    <Button loading={execution.busy} disabled={saving || (kind === 'tools' && !allowed) || (kind === 'templates' && (!uri || /[{}]/.test(uri)))} onClick={() => void execution.run(run, setOutput)}>{kind === 'tools' ? '调用工具' : kind === 'templates' ? '读取资源' : '获取提示词'}</Button>
    {execution.error && <p role="alert">{execution.error}</p>}
    {output && <section><h3>{'isError' in output && output.isError ? '工具返回错误' : '结果'}</h3><pre className={code}>{JSON.stringify(output, null, 2)}</pre></section>}
  </div>
}
