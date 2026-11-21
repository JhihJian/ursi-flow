import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import type { Inspection, McpServer } from '../client'
import { useMcp } from '../context'
import { useResource } from '../lib/use-resource'
import { cn } from '../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { PageHeader } from '../ui/page-header'
import { ResourceState } from '../ui/resource-state'
import { OperationsPanel } from './OperationsPanel'
import { SettingsPanel } from './SettingsPanel'
import { DataTable } from '../ui/data-table'
import type { CatalogKind } from '../client'
import { ResourcePreviewPanel } from './ResourcePreviewPanel'
import { ExecutorBadge, ProtocolCheckButton, protocolLabels } from './ProtocolCheck'

export function ResourceBrowser() {
  const { id } = useParams()
  const { client } = useMcp()
  const registry = useResource(client.listServers, [])
  const server = registry.data.find(entry => entry.id === id)
  return <div className="page-stack page-stack-fill">
    <PageHeader title="MCP 服务检查" actions={<Button asChild icon="chevron-left"><Link to=".." relative="path">返回服务列表</Link></Button>} />
    {server ? <Inspector key={server.id} server={server} /> : <ResourceState loading={registry.loading}
      error={registry.error} onRetry={registry.reload} empty title={registry.error ? undefined : '未找到该服务'} />}
  </div>
}

const capabilityNames = { resources: '资源', tools: '工具', prompts: '提示词' } as const

function Inspector({ server }: { server: McpServer }) {
  const [view, setView] = useState<'resources' | CatalogKind | 'settings'>('resources')
  const [protocolCheck, setProtocolCheck] = useState(server.protocolCheck)
  const checkedAt = protocolCheck ? new Date(protocolCheck.checkedAt) : undefined
  const [settings, setSettings] = useState(server.settings ?? { allowedTools: [], githubToolsets: [], githubReadOnly: false })
  const { client } = useMcp()
  const discovery = useResource<Inspection | null>(signal => client.inspectServer(server.id, signal), null)
  const result = !discovery.loading && !discovery.error ? discovery.data : null
  const peer = result?.server
  const resources = result?.resources ?? []
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const keyword = search.trim().toLowerCase()
  const matches = resources.filter(resource => [resource.name, resource.title, resource.description, resource.uri, resource.mimeType].some(value => value?.toLowerCase().includes(keyword)))
  const selectedUri = params.get('uri')
  const selected = resources.find(resource => resource.uri === selectedUri)
  function select(uri: string) {
    const next = new URLSearchParams(params)
    next.set('uri', uri)
    setParams(next, { replace: true })
  }
  return <>
    <section aria-label="服务信息" className="space-y-3 border-y border-line py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon name="connector" size={18} className="shrink-0 text-accent-2" />
        <h2 className="min-w-0 break-words text-base font-semibold text-txt">{server.name}</h2>
        <Badge variant="outline">已登记</Badge>
        <ExecutorBadge check={protocolCheck} />
        <Button className="ml-auto" size="sm" icon="refresh" loading={discovery.loading} onClick={discovery.reload}>重新发现</Button>
      </div>
      <dl className="grid gap-x-5 gap-y-2 text-xs sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0"><dt className="text-txt3">Streamable HTTP 端点</dt><dd className="mt-1 break-all font-mono text-txt2">{server.url}</dd></div>
        <div className="min-w-0"><dt className="text-txt3">凭据引用</dt><dd className="mt-1 break-all font-mono text-txt2">{server.credentialEnv ?? '无凭据'}</dd></div>
        <div className="min-w-0"><dt className="text-txt3">本次发现</dt><dd role="status" className={cn('mt-1', discovery.error ? 'text-err' : 'text-txt2')}>
          {discovery.loading ? '正在协商和发现' : discovery.error ? '发现失败' : '发现完成'}
        </dd></div>
      </dl>
      <div className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-3 text-xs">
        <dl>
          <dt className="text-txt3">最近一次成功的协议检查</dt>
          <dd className="mt-1 text-txt2" role="status">
            <span>{protocolCheck ? protocolLabels[protocolCheck.status] : '尚未完成协议检查'}</span>
            {checkedAt && <> · <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleString()}</time></>}
          </dd>
        </dl>
        <ProtocolCheckButton id={server.id} recheck={!!protocolCheck} checked={setProtocolCheck} />
      </div>
      {peer && <dl aria-label="协商信息" className="flex min-w-0 flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 text-xs text-txt2">
        <div className="flex min-w-0 gap-2"><dt className="shrink-0 text-txt3">本次协议版本</dt><dd className="font-mono">{peer.protocolVersion}</dd></div>
        <div><dt className="text-txt3">发现方式</dt><dd>{peer.discoveryMethod}</dd></div>
        <div><dt className="text-txt3">支持的协议版本</dt><dd>{peer.supportedVersions?.join('、') || '未报告版本列表'}</dd></div>
        <div><dt className="text-txt3">服务身份（自报）</dt><dd className="break-all">{[peer.title, peer.name, peer.version].filter(Boolean).join(' · ') || '未报告'}</dd></div>
        <div className="flex min-w-0 flex-wrap items-center gap-2"><dt className="text-txt3">声明能力</dt>
          <dd className="flex flex-wrap gap-1">
            {(Object.keys(capabilityNames) as (keyof typeof capabilityNames)[]).filter(key => peer.capabilities[key])
              .map(key => <Badge key={key} variant="outline">{capabilityNames[key]}</Badge>)}
            {!Object.values(peer.capabilities).some(Boolean) && '无常用能力'}
          </dd>
        </div>
      </dl>}
      {peer?.declaredCapabilities && <details className="text-xs"><summary>全部能力声明</summary><dl className="max-h-40 overflow-auto">{Object.entries(peer.declaredCapabilities).map(([name, flags]) => <div key={name} className="flex flex-wrap gap-2 p-1"><dt className="font-semibold">{name}</dt><dd className="break-all">{flags && typeof flags === 'object' && !Array.isArray(flags) ? Object.entries(flags).map(([k,v]) => `${k === 'listChanged' ? '列表变更通知' : k === 'subscribe' ? '订阅' : k}：${v === true ? '支持' : v === false ? '不支持' : JSON.stringify(v)}`).join('，') || '已声明' : JSON.stringify(flags)}</dd></div>)}</dl></details>}
      {peer?.instructions && <details className="text-xs"><summary>服务器说明</summary><p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{peer.instructions}</p></details>}
    </section>
    <nav aria-label="服务功能" className="flex flex-wrap gap-2">
      {([['resources','资源浏览'],['tools','工具目录'],['prompts','提示词目录'],['templates','资源模板'],['settings','工具设置']] as const).map(([key,title]) =>
        <Button key={key} size="sm" variant={view === key ? 'primary' : 'ghost'} aria-pressed={view === key} onClick={() => setView(key)}>{title}</Button>)}
    </nav>
    {view === 'settings' ? <SettingsPanel server={server} settings={settings} saved={s => { setSettings(s); discovery.reload() }} /> : view !== 'resources' ?
      <OperationsPanel key={view} kind={view} server={server} settings={settings} saved={setSettings} /> :
      !result ? <ResourceState loading={discovery.loading} error={discovery.error} onRetry={discovery.reload} /> :
      <div className="grid min-h-0 min-w-0 gap-4 lg:flex-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="资源列表" className="panel flex min-w-0 max-h-[45vh] flex-col overflow-hidden rounded-lg lg:max-h-none">
          <div className="space-y-2 border-b border-line px-3 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">资源列表</h2>
              <span role="status" className="text-xs tabular-nums text-txt3">
                {keyword ? `共 ${resources.length} 个资源，匹配 ${matches.length} 个` : `共 ${resources.length} 个资源`}
              </span>
            </div>
            <input type="search" className="search-input w-full" aria-label="搜索资源" placeholder="搜索名称、URI 或 MIME" value={search}
              disabled={!resources.length} onChange={event => setSearch(event.target.value)} />
          </div>
          {matches.length ? <div className="scroll-area min-h-0 overflow-auto"><DataTable key={keyword} label="资源列表" data={matches} selected={selectedUri} rowId={r => r.uri} columns={[
            { id: 'name', header: '资源名称', cell: ({ row: { original: r } }) => <><button type="button" className="break-all text-left font-medium text-accent-2" aria-current={r.uri === selectedUri || undefined} onClick={() => select(r.uri)}>{r.title || r.name}</button>{r.title && <small className="block">{r.name}</small>}{r.description && <p className="line-clamp-2 text-xs text-txt3">{r.description}</p>}</> },
            { accessorKey: 'uri', header: 'URI', cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.uri}</span> },
            { id: 'mime', header: '媒体类型', cell: ({ row }) => row.original.mimeType || '未提供' },
            { id: 'size', header: '大小', cell: ({ row }) => row.original.size == null ? '未提供' : `${row.original.size} B` },
          ]} /></div> : <p className="p-3 text-sm text-txt3">{!peer?.capabilities.resources ? '服务未声明资源能力' : resources.length ? '没有匹配的资源' : '资源列表为空'}</p>}
        </section>
        <section aria-label="资源预览" className="panel flex min-h-[14rem] min-w-0 flex-col overflow-hidden rounded-lg p-4 lg:min-h-0">
          {selected ? <ResourcePreviewPanel key={selected.uri} serverId={server.id} resource={selected} /> :
            <p className="m-auto flex max-w-sm flex-col items-center gap-2 text-center text-sm text-txt3">
              <Icon name="stage-resources" size={22} />
              {selectedUri ? '指定 URI 不在本次资源列表中' : '未选择资源'}
            </p>}
        </section>
      </div>}
  </>
}
