import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'
import { categories, getWorkItem, saveWorkItem, statuses, workItemPath, type Category, type WorkItem, type WorkStatus } from '@/shared/api/work-items'
import { resolveInputs } from '@/modules/work-patch-generators/inputs'
import { GeneratorBindingEditor, type BindingDraft } from './GeneratorBindingEditor'

export function ItemEditor() {
  const { id } = useParams()
  return id ? <EditExisting key={id} id={id} /> : <Form />
}
function EditExisting({ id }: { id: string }) {
  const item = useResource(signal => getWorkItem(id, signal), null)
  return item.data ? <Form item={item.data} /> : <ResourceState loading={item.loading} error={item.error} onRetry={item.reload} />
}
function Form({ item }: { item?: WorkItem }) {
  const navigate = useNavigate()
  const mutation = useMutation()
  const [title, setTitle] = useState(item?.title ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [category, setCategory] = useState<Category>(item?.category ?? 'one_time')
  const [status, setStatus] = useState<WorkStatus>(item?.status ?? 'pending')
  const [binding, setBinding] = useState<BindingDraft>(() => item?.generator
    ? { ...item.generator, aliases: item.generator.resources.map(r => r.alias) }
    : { id: '', revision: 0, aliases: [], resources: [] })
  const [validation, setValidation] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return setValidation('请填写标题。')
    const resources = resolveInputs(binding.aliases, binding.resources)
    if (binding.id && (!binding.revision || !resources)) return setValidation('请为每个输入别名选择 MCP 资源。')
    setValidation('')
    const generator = binding.id && resources ? { id: binding.id, revision: binding.revision, resources } : null
    void mutation.run(signal => saveWorkItem({ title: title.trim(), description, category, status, generator }, item, signal),
      saved => navigate(workItemPath(saved.id), { replace: true }))
  }
  return <div className="page-stack">
    <PageHeader title={item ? '编辑工作项' : '新建工作项'} />
    <form onSubmit={submit} className="max-w-3xl"><fieldset disabled={mutation.busy} className="grid min-w-0 gap-4 text-sm">
      <label>标题<Input required value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>工作说明<Textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label>类别<Select value={category} onChange={e => setCategory(e.target.value as Category)}>
        {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></label>
      {item && <label>状态<Select value={status} onChange={e => setStatus(e.target.value as WorkStatus)}>
        {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></label>}
      <GeneratorBindingEditor draft={binding} change={setBinding} />
      {(validation || mutation.error) && <p role="alert" className="text-err">{validation || mutation.error}</p>}
      <div className="flex gap-2"><Button type="submit" variant="primary" loading={mutation.busy}>保存工作项</Button>
        <Button asChild><Link to={item ? workItemPath(item.id) : '/work-items'}>取消</Link></Button></div>
    </fieldset></form>
  </div>
}
