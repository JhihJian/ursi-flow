import { useState } from 'react'
import { Link } from 'react-router'
import { mcpClient } from '@/shared/api/mcp'
import type { ResourceRef } from '@/shared/api/work-patch-generators'
import { useResource } from '@/shared/hooks/use-resource'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'

export function ResourceInputs({ aliases, refs, onChange }: {
  aliases: string[]; refs: ResourceRef[]; onChange: (refs: ResourceRef[]) => void
}) {
  return aliases.length ? <Inputs aliases={aliases} refs={refs} onChange={onChange} /> : <p className="text-sm text-txt3">此版本无需 MCP 资源。</p>
}

function Inputs({ aliases, refs, onChange }: Parameters<typeof ResourceInputs>[0]) {
  const servers = useResource(mcpClient.listServers, [])
  return <div className="grid gap-3">
    <ResourceState loading={servers.loading} error={servers.error} onRetry={servers.reload} />
    {!servers.loading && !servers.error && !servers.data.length && <p>尚未登记服务。<Link className="text-accent-2 underline" to="/mcp-servers">平台 MCP 服务</Link></p>}
    {aliases.map(alias => <InputRow key={alias} alias={alias} servers={servers.data} selected={refs.find(ref => ref.alias === alias)} onSelect={ref => {
      const rest = refs.filter(r => r.alias !== alias)
      onChange(ref ? [...rest, ref] : rest)
    }} />)}
  </div>
}

function InputRow({ alias, servers, selected, onSelect }: {
  alias: string; servers: { id: string; name: string }[]; selected?: ResourceRef; onSelect: (ref?: ResourceRef) => void
}) {
  const [serverId, setServerId] = useState(selected?.serverId ?? '')
  return <fieldset className="grid min-w-0 gap-2 border-l-2 border-line pl-3">
    <legend className="break-all font-medium">{alias}</legend>
    <label>MCP 服务<Select aria-label={`${alias} 的 MCP 服务`} value={serverId} onChange={e => {
      setServerId(e.target.value)
      onSelect()
    }}>
      <option value="">选择服务</option>
      {servers.map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
      {serverId && !servers.some(s => s.id === serverId) && <option value={serverId}>{serverId}</option>}
    </Select></label>
    {serverId && <ResourceSelect key={serverId} serverId={serverId} alias={alias} uri={selected?.uri ?? ''} onSelect={onSelect} />}
  </fieldset>
}

function ResourceSelect({ serverId, alias, uri, onSelect }: {
  serverId: string; alias: string; uri: string; onSelect: (ref?: ResourceRef) => void
}) {
  const resources = useResource(signal => mcpClient.listResources(serverId, signal), [])
  return <>
    <label>MCP 资源<Select aria-label={`${alias} 的 MCP 资源`} value={uri} disabled={resources.loading || !!resources.error}
      onChange={e => onSelect(e.target.value ? { alias, serverId, uri: e.target.value } : undefined)}>
      <option value="">选择资源</option>
      {resources.data.map(r => <option key={r.uri} value={r.uri}>{r.name} · {r.uri}</option>)}
      {uri && !resources.data.some(r => r.uri === uri) && <option value={uri}>{uri}</option>}
    </Select></label>
    <ResourceState loading={resources.loading} error={resources.error} onRetry={resources.reload}
      empty={!resources.data.length} title={resources.error ? undefined : '此服务暂无资源'} />
  </>
}
