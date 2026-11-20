import { useState } from 'react'
import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { listResources, listServers } from '@/shared/api/mcp'
import type { Recipe, ResourceRef } from '@/shared/api/work-items'

function ResourceChoices({ serverId, selected, change }: {
  serverId: string; selected: ResourceRef[]; change: (refs: ResourceRef[]) => void
}) {
  const resources = useResource(signal => listResources(serverId, signal), [])
  return <div className="space-y-2">
    <ResourceState loading={resources.loading} error={resources.error} onRetry={resources.reload}
      empty={!resources.data.length} title={resources.error ? undefined : '此服务暂无资源'} />
    {resources.data.map(({ name, uri }) => {
      const matches = (ref: ResourceRef) => ref.serverId === serverId && ref.uri === uri
      return <label className="flex items-baseline gap-2 break-all text-sm" key={uri}>
        <input type="checkbox" checked={selected.some(matches)} onChange={e => change(e.target.checked
          ? [...selected, { serverId, uri, alias: '' }] : selected.filter(ref => !matches(ref)))} />
        {name} · {uri}
      </label>
    })}
  </div>
}

export function RecipeEditor({ recipe, change }: { recipe: Recipe; change: (next: Recipe) => void }) {
  const servers = useResource(listServers, [])
  const [serverId, setServerId] = useState('')
  const setResources = (resources: ResourceRef[]) => change({ ...recipe, resources })
  return <div className="grid gap-3 border-l-2 border-line pl-4">
    <ResourceState loading={servers.loading} error={servers.error} onRetry={servers.reload} />
    {!servers.loading && !servers.error && (servers.data.length
      ? <label>资源服务<Select value={serverId} onChange={e => setServerId(e.target.value)}>
          <option value="">选择服务</option>{servers.data.map(s => <option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}
        </Select></label>
      : <p>尚未登记服务。<Link className="text-accent-2 underline" to="/mcp-servers">平台 MCP 服务</Link></p>)}
    {serverId && <ResourceChoices key={serverId} serverId={serverId} selected={recipe.resources} change={setResources} />}
    <ol className="space-y-2">{recipe.resources.map((ref, i) => <li key={JSON.stringify([ref.serverId, ref.uri])} className="grid gap-1 border-t border-line pt-2">
      <span className="break-all text-txt2">{i + 1}. {servers.data.find(s => s.id === ref.serverId)?.name ?? ref.serverId} · {ref.uri}</span>
      <div className="flex items-end gap-2"><label className="min-w-0 flex-1">资源别名 {i + 1}<Input required value={ref.alias} onChange={e => setResources(recipe.resources.map((r, n) => n === i ? { ...r, alias: e.target.value } : r))} /></label>
        <Button onClick={() => setResources(recipe.resources.filter((_, n) => i !== n))} aria-label={`移除资源 ${i + 1}`}>移除</Button></div>
    </li>)}</ol>
    <label>Python 脚本<Textarea required className="font-mono" rows={9} spellCheck={false} value={recipe.script}
      placeholder={'def transform(item, resources):\n    ...'} onChange={e => change({ ...recipe, script: e.target.value })} /></label>
  </div>
}
