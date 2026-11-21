import { Link } from 'react-router'
import { generatorsPath, listGeneratorRevisions, listGenerators, type GeneratorBinding } from '@/shared/api/work-patch-generators'
import { useResource } from '@/shared/hooks/use-resource'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { ResourceInputs } from '@/modules/work-patch-generators/ResourceInputs'

export type BindingDraft = GeneratorBinding & { aliases: string[] }

export function GeneratorBindingEditor({ draft, change }: { draft: BindingDraft; change: (draft: BindingDraft) => void }) {
  const catalog = useResource(listGenerators, [])
  return <div className="grid min-w-0 gap-3 border-l-2 border-line pl-4">
    <ResourceState loading={catalog.loading} error={catalog.error} onRetry={catalog.reload} />
    {!catalog.loading && !catalog.error && !catalog.data.length && <p>暂无已发布的生成器。<Link className="text-accent-2 underline" to={generatorsPath}>工作包生成器</Link></p>}
    <label>生成器<Select value={draft.id} onChange={e => change({ id: e.target.value, revision: 0, aliases: [], resources: [] })}>
      <option value="">选择生成器</option>
      {catalog.data.map(g => <option key={g.id} value={g.id}>{g.name} · {g.id}</option>)}
      {draft.id && !catalog.data.some(g => g.id === draft.id) && <option value={draft.id}>{draft.id}</option>}
    </Select></label>
    {draft.id && <Revisions key={draft.id} draft={draft} change={change} />}
    {draft.revision > 0 && <ResourceInputs key={JSON.stringify([draft.id, draft.revision])} aliases={draft.aliases} refs={draft.resources}
      onChange={resources => change({ ...draft, resources })} />}
  </div>
}

function Revisions({ draft, change }: { draft: BindingDraft; change: (draft: BindingDraft) => void }) {
  const history = useResource(signal => listGeneratorRevisions(draft.id, signal), [])
  const choices = [...history.data].sort((a, b) => b.revision - a.revision)
  return <>
    <ResourceState loading={history.loading} error={history.error} onRetry={history.reload} empty={!choices.length}
      title={history.error ? undefined : '暂无已发布版本'} />
    <label>生成器版本<Select value={draft.revision || ''} disabled={history.loading || !!history.error} onChange={e => {
      const next = choices.find(value => String(value.revision) === e.target.value)
      change({ id: draft.id, revision: next?.revision ?? 0, aliases: next?.aliases ?? [], resources: [] })
    }}>
      <option value="">选择版本</option>
      {choices.map(g => <option key={g.revision} value={g.revision}>第 {g.revision} 版 · {g.name}</option>)}
      {draft.revision > 0 && !choices.some(g => g.revision === draft.revision) && <option value={draft.revision}>第 {draft.revision} 版</option>}
    </Select></label>
  </>
}
