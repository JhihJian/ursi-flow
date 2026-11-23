import { useState } from 'react'
import { Link } from 'react-router'
import { listWorkItems, workItemPath } from '@/shared/api/work-items'
import { generationRunPath, generatorRevisionPath } from '@/shared/api/work-patch-generators'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Modal } from '@/shared/ui/modal'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { setPatchOwner, type Patch } from './api'

export function PatchOwner({ patch, onSaved }: { patch: Patch; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const source = patch.provenance
  return <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-1 text-xs">
    <span>关联工作项：</span>{patch.workItemId
      ? <Link className="min-w-0 truncate text-accent-2 hover:underline" to={workItemPath(patch.workItemId)}>{patch.workItemId}</Link>
      : <span className="text-txt3">未关联</span>}
    <Button size="sm" onClick={() => setEditing(true)}>更改关联</Button>
    {source && <><Button size="sm" variant="ghost" onClick={() => setSourceOpen(true)}>生成来源</Button>
      <Modal open={sourceOpen} title="生成来源" onClose={() => setSourceOpen(false)}>
        <div className="space-y-3 break-all text-sm"><p>生成时的工作项：{source.workItemTitle} · {source.workItemId}</p>
          {source.runId && <p><Link className="text-accent-2 underline" to={generationRunPath(source.runId)}>查看生成记录</Link></p>}
          {source.generator && <p>生成器：<Link className="text-accent-2 underline" to={generatorRevisionPath(source.generator)}>
            {source.generator.id} · 第 {source.generator.revision} 版</Link></p>}
          <p>工作项修订：{source.revision}</p><p>脚本摘要：{source.scriptSha256}</p>
          <ul className="space-y-2">{source.resources.map(r => <li key={r.alias}><strong>{r.alias}</strong> · {r.serverId} · {r.uri}
            <p>内容摘要：{r.sha256}</p><p>读取时间：{new Date(r.readAt).toLocaleString()}</p></li>)}</ul>
        </div>
      </Modal></>}
    {editing && <OwnerDialog patch={patch} close={() => setEditing(false)} saved={() => { setEditing(false); onSaved() }} />}
  </div>
}
function OwnerDialog({ patch, close, saved }: { patch: Patch; close: () => void; saved: () => void }) {
  const items = useResource(listWorkItems, [])
  const [selected, setSelected] = useState(patch.workItemId ?? '')
  const mutation = useMutation()
  return <Modal open title="关联工作项" onClose={() => { if (!mutation.busy) close() }} footer={<>
    <Button onClick={close} disabled={mutation.busy}>取消</Button>
    <Button variant="primary" loading={mutation.busy} disabled={items.loading || !!items.error || selected === (patch.workItemId ?? '')}
      onClick={() => void mutation.run(signal => setPatchOwner(patch.id, selected || null, signal), saved)}>保存关联</Button></>}>
    <ResourceState loading={items.loading} error={items.error} onRetry={items.reload} />
    {!items.loading && !items.error && <label>工作项<Select disabled={mutation.busy} value={selected} onChange={e => setSelected(e.target.value)}>
      <option value="">不关联工作项</option>{items.data.map(item => <option key={item.id} value={item.id}>{item.title} · {item.id}</option>)}
    </Select></label>}
    {mutation.error && <p role="alert" className="text-err">{mutation.error}</p>}
  </Modal>
}
