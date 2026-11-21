import { useState } from 'react'
import { fetchCatalog, invoke, readResource, saveSettings, type CatalogEntry, type CatalogKind, type McpServer, type McpSettings } from '@/shared/api/mcp'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction, notify } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { ResourceState } from '@/shared/ui/resource-state'

type Props = { server: McpServer; settings: McpSettings; saved: (s: McpSettings) => void }
const titles = { tools: '工具', prompts: '提示词', templates: '资源模板' }
const code = 'max-h-64 overflow-auto whitespace-pre-wrap break-all bg-elevated p-3 text-xs'
const split = (value: string) => value.split(/[,\s]+/).filter(Boolean)

export function SettingsPanel({ server, settings, saved }: Props) {
  const [sets, setSets] = useState(settings.githubToolsets.join(', '))
  const [readOnly, setReadOnly] = useState(settings.githubReadOnly)
  const [allowed, setAllowed] = useState(settings.allowedTools.join('\n'))
  const mutation = useMutation()
  return <section className="scroll-area grid min-h-0 content-start gap-4 overflow-auto py-3">
    {server.url === 'https://api.githubcopilot.com/mcp/' && <fieldset className="grid gap-2"><legend className="font-semibold">GitHub 工具集</legend>
      <label>工具集标识（逗号分隔）<Input placeholder="repos, issues, pull_requests" value={sets} onChange={e => setSets(e.target.value)} /></label>
      <label><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} /> 仅请求 GitHub 只读工具</label>
    </fieldset>}
    <label>允许调用的工具（每行一个，默认不授权）<textarea className="input block w-full font-mono" rows={5} value={allowed} onChange={e => setAllowed(e.target.value)} /></label>
    <Button loading={mutation.busy} onClick={() => void mutation.run(signal => saveSettings(server.id, { allowedTools: split(allowed), githubToolsets: split(sets), githubReadOnly: readOnly }, signal), s => { saved(s); notify('工具设置已保存') })}>保存工具设置</Button>
    {mutation.error && <p role="alert">{mutation.error}</p>}
  </section>
}

export function OperationsPanel(props: Props & { kind: CatalogKind }) {
  const { kind, server } = props
  const list = useResource(signal => fetchCatalog(server.id, kind, signal), [])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const items = list.data.filter(x => `${x.name} ${x.description ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const key = (x: CatalogEntry) => x.uriTemplate ?? x.name
  const item = items.find(x => key(x) === selected) ?? items[0]
  return <section className="scroll-area grid min-h-0 content-start gap-3 overflow-auto py-3">
    <div className="flex items-center justify-between"><h2>{titles[kind]}目录 · {list.data.length}</h2><Button size="sm" icon="refresh" onClick={list.reload}>刷新目录</Button></div>
    {list.loading || list.error || !list.data.length ? <ResourceState loading={list.loading} error={list.error} empty onRetry={list.reload} title={list.error ? undefined : '目录为空'} /> : <>
      <Input aria-label="搜索目录" placeholder="搜索名称或说明" value={search} onChange={e => setSearch(e.target.value)} />
      {item ? <><Select aria-label={`选择${titles[kind]}`} value={key(item)} onChange={e => setSelected(e.target.value)}>{items.map(x => <option key={key(x)} value={key(x)}>{x.name}</option>)}</Select>
        <Entry key={key(item)} {...props} item={item} /></> : <p>没有匹配项</p>}
    </>}
  </section>
}

function Entry({ server, settings, saved, item, kind }: Props & { item: CatalogEntry; kind: CatalogKind }) {
  const [args, setArgs] = useState('{}')
  const [uri, setUri] = useState(item.uriTemplate ?? '')
  const [output, setOutput] = useState<Record<string, unknown> | null>(null)
  const execution = useMutation()
  const permission = useMutation()
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
    {kind === 'tools' && <label><input type="checkbox" checked={allowed} disabled={permission.busy || execution.busy} onChange={e => {
      const allowedTools = e.target.checked ? [...settings.allowedTools, item.name] : settings.allowedTools.filter(n => n !== item.name)
      void permission.run(signal => saveSettings(server.id, { ...settings, allowedTools }, signal), saved)
    }} /> 允许调用此工具</label>}
    <Button loading={execution.busy} disabled={permission.busy || (kind === 'tools' && !allowed) || (kind === 'templates' && (!uri || /[{}]/.test(uri)))} onClick={() => void execution.run(run, setOutput)}>{kind === 'tools' ? '调用工具' : kind === 'templates' ? '读取资源' : '获取提示词'}</Button>
    {(execution.error || permission.error) && <p role="alert">{execution.error || permission.error}</p>}
    {output && <section><h3>{'isError' in output && output.isError ? '工具返回错误' : '结果'}</h3><pre className={code}>{JSON.stringify(output, null, 2)}</pre></section>}
  </div>
}
