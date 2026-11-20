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
import { categories, getWorkItem, saveWorkItem, workItemPath, type Category, type Recipe, type WorkItem } from '@/shared/api/work-items'
import { RecipeEditor } from './RecipeEditor'

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
  const [category, setCategory] = useState<Category>(item?.category ?? 'pending')
  const [enabled, enable] = useState(Boolean(item?.recipe))
  const [draft, setDraft] = useState<Recipe>(item?.recipe ?? { resources: [], script: '' })
  const [validation, setValidation] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    const refs = draft.resources.map(ref => ({ ...ref, alias: ref.alias.trim() }))
    const aliases = refs.map(ref => ref.alias)
    if (!title.trim()) return setValidation('请填写标题。')
    if (enabled && (!refs.length || !draft.script.trim())) return setValidation('配方需要至少一个资源和 Python 脚本。')
    if (enabled && (aliases.includes('') || new Set(aliases).size !== refs.length)) return setValidation('资源别名不能为空或重复。')
    setValidation('')
    const recipe = enabled ? { resources: refs, script: draft.script } : null
    void mutation.run(signal => saveWorkItem({ title: title.trim(), description, category, recipe }, item, signal),
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
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => enable(e.target.checked)} />配置工作包来源</label>
      {enabled && <RecipeEditor recipe={draft} change={setDraft} />}
      {(validation || mutation.error) && <p role="alert" className="text-err">{validation || mutation.error}</p>}
      <div className="flex gap-2"><Button type="submit" variant="primary" loading={mutation.busy}>保存工作项</Button>
        <Button asChild><Link to={item ? workItemPath(item.id) : '/work-items'}>取消</Link></Button></div>
    </fieldset></form>
  </div>
}
