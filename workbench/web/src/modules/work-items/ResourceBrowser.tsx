import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { cn } from '@/shared/lib/utils'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Icon } from '@/shared/ui/icon'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { listResources, listServers, type McpResource } from '@/shared/api/work-items'
import { ResourcePreviewPanel } from './ResourcePreviewPanel'

export function ResourceBrowser() {
  const { id = '' } = useParams()
  return <Browse key={id} serverId={id} />
}

function Browse({ serverId }: { serverId: string }) {
  const servers = useResource(listServers, [])
  const resources = useResource(signal => listResources(serverId, signal), [] as McpResource[])
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const server = servers.data.find(entry => entry.id === serverId)
  const keyword = search.trim().toLowerCase()
  const visible = resources.data.filter(resource => !keyword
    || resource.name.toLowerCase().includes(keyword)
    || resource.uri.toLowerCase().includes(keyword))
  const selectedUri = params.get('uri') ?? ''
  const selected = resources.data.find(resource => resource.uri === selectedUri)
  function select(uri: string) {
    const next = new URLSearchParams(params)
    next.set('uri', uri)
    setParams(next, { replace: true })
  }
  const listReady = !resources.error && visible.length > 0
  // 刷新时保留上一次的列表，骨架只用于首次加载。
  const firstLoad = resources.loading && !resources.data.length
  return <div className="page-stack page-stack-fill">
    <PageHeader
      title={server?.name ?? '资源浏览'}
      description={server?.url}
      actions={<Button asChild icon="chevron-left"><Link to="/mcp-servers">返回服务列表</Link></Button>}
    />
    {servers.error ? <ResourceState error={servers.error} onRetry={servers.reload} /> : null}
    {!servers.loading && !servers.error && !server ? <ResourceState
      title="未找到该服务"
      description="服务不存在或已被删除，返回列表后重新登记。"
      error="服务不在已登记列表中。"
      onRetry={servers.reload}
    /> : null}
    {server ? <div className="grid min-h-0 gap-5 lg:flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section aria-label="资源列表" className="panel flex max-h-[50vh] min-h-[280px] flex-col p-4 lg:max-h-none lg:min-h-0">
        <div className="flex items-center gap-2">
          <input
            type="search"
            className="search-input"
            aria-label="搜索资源"
            placeholder="按名称或 URI 搜索"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <Button size="icon" icon="refresh" aria-label="重新发现资源" loading={resources.loading} onClick={resources.reload} />
        </div>
        <p role="status" className="mt-3 text-xs text-txt3">
          {keyword ? `共 ${resources.data.length} 个资源，匹配 ${visible.length} 个` : `共 ${resources.data.length} 个资源`}
        </p>
        <ResourceState
          className="mt-3 border-0 bg-transparent p-0 shadow-none"
          loading={firstLoad}
          error={resources.error}
          onRetry={resources.reload}
          empty={!visible.length}
          title={resources.error ? undefined : keyword ? '没有匹配的资源' : '此服务未提供资源'}
          description={resources.error ? undefined : keyword ? '换个关键词，或清空搜索查看全部资源。' : '服务协商成功，但资源列表为空。'}
        />
        {listReady ? <ul className="scroll-area mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
          {visible.map(resource => <li key={resource.uri}>
            <button
              type="button"
              aria-current={resource.uri === selectedUri ? 'true' : undefined}
              onClick={() => select(resource.uri)}
              className={cn(
                'w-full rounded-lg px-2 py-2 text-left transition-colors',
                resource.uri === selectedUri ? 'bg-accent-dim text-txt' : 'text-txt2 hover:bg-elevated',
              )}
            >
              <span className="block truncate text-sm font-medium">{resource.name}</span>
              <span className="block truncate text-xs text-txt3">{resource.uri}</span>
            </button>
          </li>)}
        </ul> : null}
      </section>
      <section aria-label="资源预览" className="panel flex max-h-[70vh] min-h-[320px] flex-col p-4 lg:max-h-none lg:min-h-0">
        {selected ? <ResourcePreviewPanel key={selected.uri} serverId={serverId} resource={selected} /> : (
          <p className="m-auto flex max-w-sm flex-col items-center gap-3 text-center text-sm leading-6 text-txt3">
            <Icon name="stage-resources" size={24} />
            {selectedUri
              ? <>地址中的资源不在本次列表里，可能已被服务移除。</>
              : <>从左侧选择一个资源查看内容。</>}
          </p>
        )}
      </section>
    </div> : null}
  </div>
}
