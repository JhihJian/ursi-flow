import { useState } from 'react'
import type { CatalogEntry, CatalogKind, McpServer, McpSettings } from '../client'
import { SchemaForm, buildArgs, formable, hydrate, type FormValues } from './SchemaForm'
import { ResultView } from './ResultView'
import { useMcp } from '../context'
import { useMutation } from '../lib/use-mutation'
import { useResource } from '../lib/use-resource'
import { useFeedback } from '../ui/feedback'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { DataTable } from '../ui/data-table'
import { Switch } from '../ui/switch'
import { Tabs } from '../ui/tabs'
import { Icon } from '../ui/icon'
import { Badge } from '../ui/badge'
import type { ColumnDef } from '@tanstack/react-table'
import { ResourceState } from '../ui/resource-state'
import { cn } from '../lib/utils'

type Props = { server: McpServer; settings: McpSettings; saved: (s: McpSettings) => void }
const titles = { tools: '工具', prompts: '提示词', templates: '资源模板' }
const code = 'max-h-64 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs'

export function OperationsPanel(props: Props & { kind: CatalogKind }) {
  const { client } = useMcp()
  const { kind, server } = props
  const list = useResource(signal => client.fetchCatalog(server.id, kind, signal), [])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const items = list.data.filter(x => `${x.name} ${x.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const key = (x: CatalogEntry) => x.uriTemplate ?? x.name
  const item = items.find(x => key(x) === selected) ?? (kind === 'tools' ? undefined : items[0])
  const permission = useMutation()
  const columns: ColumnDef<CatalogEntry>[] = [
    { id: 'name', header: '名称', cell: ({ row: { original: x } }) => <button className="block max-w-56 truncate text-left font-mono text-xs font-medium text-accent-2" title={x.name} aria-pressed={key(x) === selected} onClick={() => setSelected(key(x))}>{x.name}</button> },
    { accessorKey: 'description', header: '说明', cell: ({ row }) => <span className="line-clamp-2 text-txt2">{row.original.description || '未提供'}</span> },
  ]
  if (kind === 'tools') columns.push({ id: 'permission', header: '允许调用', cell: ({ row: { original: x } }) => <Switch aria-label={`允许调用 ${x.name}`} checked={props.settings.allowedTools.includes(x.name)} disabled={permission.busy} onCheckedChange={on => {
    const allowedTools = on ? [...props.settings.allowedTools, x.name] : props.settings.allowedTools.filter(n => n !== x.name)
    void permission.run(signal => client.saveSettings(server.id, { ...props.settings, allowedTools }, signal), props.saved)
  }} /> })
  const nav = <div className="flex flex-wrap items-center justify-between gap-2">
    <h2 className="text-sm font-semibold text-txt">{titles[kind]}目录<span className="ml-1.5 text-xs font-normal text-txt3">共 {list.data.length} 项</span></h2>
    <Button size="sm" variant="outline" icon="refresh" loading={list.loading} onClick={list.reload}>刷新目录</Button>
  </div>
  return <div className="grid min-h-0 min-w-0 content-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <section aria-label={`${titles[kind]}列表`} className="panel flex min-h-[16rem] min-w-0 flex-col overflow-hidden">
      {nav}
      <div className="border-b border-line p-3">
        <Input aria-label="搜索目录" placeholder="搜索名称或说明" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {list.loading || list.error || !list.data.length ? <ResourceState loading={list.loading} error={list.error} empty onRetry={list.reload} title={list.error ? undefined : '目录为空'} /> : <>
        <div className="scroll-area min-h-0 flex-1 overflow-auto">
          {items.length ? <DataTable key={search} label={`${titles[kind]}目录`} columns={columns} data={items} rowId={key} selected={item && key(item)} /> : <p className="p-3 text-sm text-txt3">没有匹配项</p>}
        </div>
        {permission.error && <p role="alert" className="border-t border-line p-3 text-sm text-err">{permission.error}</p>}
        <p className="border-t border-line px-3 py-2 text-xs text-txt3">点选左侧{titles[kind]}名称后在右侧填写参数并调用</p>
      </>}
    </section>
    <section aria-label={`${titles[kind]}详情`} className="panel min-w-0 self-start">
      {item ? <Entry key={key(item)} {...props} item={item} saving={permission.busy} /> :
        <p className="flex flex-col items-center gap-2 p-8 text-center text-sm text-txt3">
          <Icon name={kind === 'tools' ? 'connector' : kind === 'prompts' ? 'folder' : 'stage-resources'} size={22} />
          {kind === 'tools' ? '选择一个工具后填写参数调用' : `选择一个${titles[kind]}查看详情`}
        </p>}
    </section>
  </div>
}

function Entry({ server, settings, item, kind, saving }: Props & { item: CatalogEntry; kind: CatalogKind; saving: boolean }) {
  const { client } = useMcp()
  const { confirmAction } = useFeedback()
  const schema = item.inputSchema
  const [mode, setMode] = useState<'form' | 'json'>(formable(schema) ? 'form' : 'json')
  const [values, setValues] = useState<FormValues>(() => formable(schema) ? {} : {})
  const [args, setArgs] = useState('{}')
  const [uri, setUri] = useState(item.uriTemplate ?? '')
  const [output, setOutput] = useState<Record<string, unknown> | null>(null)
  const execution = useMutation()
  const allowed = settings.allowedTools.includes(item.name)
  function switchMode(next: 'form' | 'json') {
    if (next === mode) return
    if (next === 'json') {
      let input: Record<string, unknown> = {}
      try { input = buildArgs(schema!, values, true) } catch { /* 保留已填内容能转换的部分 */ }
      setArgs(JSON.stringify(input, null, 2))
    } else {
      try { setValues(hydrate(schema!, JSON.parse(args))) } catch { /* 非法 JSON 时保留原表单值 */ }
    }
    setMode(next)
  }
  function currentInput(): Record<string, unknown> {
    if (mode === 'json') {
      let input: unknown
      try { input = JSON.parse(args) } catch { throw Error('参数不是合法 JSON') }
      if (!input || Array.isArray(input) || typeof input !== 'object') throw Error('参数须为 JSON 对象')
      return input as Record<string, unknown>
    }
    return buildArgs(schema!, values)
  }
  async function run(signal: AbortSignal) {
    setOutput(null)
    if (kind === 'templates') return client.readResource(server.id, uri, signal)
    const input = currentInput()
    if (kind === 'tools' && !await confirmAction({ title: `调用 ${item.name}？`, description: `将向 ${server.url} 提交当前参数。此操作可能修改远端数据。`, confirmLabel: '确认调用', danger: true })) return null
    if (signal.aborted) return null
    return client.invoke(server.id, kind, item.name, input, signal)
  }
  return <div className="grid min-w-0 gap-4 p-4 text-sm">
    <header className="min-w-0 border-b border-line pb-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={kind === 'templates' ? 'folder' : 'connector'} size={16} className="shrink-0 text-accent-2" />
        <h3 className="min-w-0 truncate font-mono text-sm font-semibold text-txt" title={item.name}>{item.name}</h3>
        {kind === 'tools' && <Badge variant={allowed ? 'secondary' : 'outline'} className="shrink-0">{allowed ? '已授权' : '未授权'}</Badge>}
        {formable(schema) && <Tabs className="ml-auto shrink-0" label="参数填写方式" value={mode} onValue={switchMode}
          items={[{ value: 'form', title: '表单填写' }, { value: 'json', title: 'JSON 模式' }]} />}
      </div>
      {item.description && <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-xs text-txt2">{item.description}</p>}
    </header>
    {kind === 'templates' ? <label className="grid gap-1"><span className="font-medium">具体资源 URI</span><Input className="font-mono text-xs" value={uri} onChange={e => setUri(e.target.value)} /></label> : <>
      {mode === 'form'
        ? <SchemaForm schema={schema!} values={values} onChange={setValues} />
        : <>
          <details className="text-xs"><summary className="cursor-pointer font-medium text-accent-2">参数定义</summary><pre className={cn(code, 'mt-2 rounded-lg border border-line')}>{JSON.stringify(schema ?? item.arguments ?? [], null, 2)}</pre></details>
          <label className="grid gap-1"><span className="font-medium">调用参数（JSON 对象）</span><textarea className="input block w-full font-mono" rows={6} value={args} onChange={e => setArgs(e.target.value)} /></label>
        </>}
    </>}
    <div className="flex items-center gap-3">
      <Button loading={execution.busy} disabled={saving || (kind === 'tools' && !allowed) || (kind === 'templates' && (!uri || /[{}]/.test(uri)))} onClick={() => void execution.run(run, setOutput)}>{kind === 'tools' ? '调用工具' : kind === 'templates' ? '读取资源' : '获取提示词'}</Button>
      {kind === 'tools' && !allowed && <span className="text-xs text-txt3">先在左侧列表打开「允许调用」开关</span>}
    </div>
    {execution.error && <p role="alert" className="rounded-lg border border-err/40 bg-err/10 p-3 text-err">{execution.error}</p>}
    {output && <ResultView output={output} />}
  </div>
}
