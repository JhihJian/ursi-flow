import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { generatorRevisionPath, generatorsPath, getGenerator, publishGenerator, type Generator } from '@/shared/api/work-patch-generators'
import { useMutation } from '@/shared/hooks/use-mutation'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { Textarea } from '@/shared/ui/textarea'

export function GeneratorEditor() {
  const { id } = useParams()
  return id ? <LoadDraft key={id} id={id} /> : <Editor />
}

function LoadDraft({ id }: { id: string }) {
  const source = useResource(signal => getGenerator(id, signal), null)
  return source.data ? <Editor source={source.data} /> : <div className="page-stack">
    <PageHeader title="发布新版" actions={<Button asChild><Link to={generatorsPath}>返回生成器列表</Link></Button>} />
    <ResourceState loading={source.loading} error={source.error} onRetry={source.reload} />
  </div>
}

function Editor({ source }: { source?: Generator }) {
  const navigate = useNavigate()
  const [id, setId] = useState(source?.id ?? '')
  const [name, setName] = useState(source?.name ?? '')
  const [aliasesText, setAliasesText] = useState(source?.aliases.join('\n') ?? '')
  const [script, setScript] = useState(source?.script ?? '')
  const [validation, setValidation] = useState('')
  const mutation = useMutation()

  function submit(event: FormEvent) {
    event.preventDefault()
    const aliases = aliasesText.split('\n').map(value => value.trim()).filter(Boolean)
    if (!id.trim() || !name.trim() || !script.trim()) return setValidation('请填写生成器 ID、名称和 Python 脚本。')
    if (new Set(aliases).size !== aliases.length) return setValidation('输入别名不能重复。')
    setValidation('')
    const body = { id: id.trim(), name: name.trim(), aliases, script }
    void mutation.run(signal => publishGenerator(body, signal), saved => navigate(generatorRevisionPath(saved), { replace: true }))
  }

  return <div className="page-stack max-w-3xl">
    <PageHeader title={source ? '发布新版' : '新建工作包生成器'} description={source && `基于 ${source.name} 第 ${source.revision} 版`} />
    <form onSubmit={submit}><fieldset disabled={mutation.busy} className="grid min-w-0 gap-4 text-sm">
      <label>生成器 ID<Input required readOnly={!!source} value={id} onChange={e => setId(e.target.value)} /></label>
      <label>名称<Input required value={name} onChange={e => setName(e.target.value)} /></label>
      <label>输入别名（每行一个）<Textarea rows={3} value={aliasesText} onChange={e => setAliasesText(e.target.value)} /></label>
      <label>Python 脚本<Textarea required rows={12} className="font-mono" spellCheck={false}
        placeholder={'def transform(item, resources):\n    ...'} value={script} onChange={e => setScript(e.target.value)} /></label>
      {(validation || mutation.error) && <p role="alert" className="text-err">{validation || mutation.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={mutation.busy}>{source ? '发布新版' : '发布生成器'}</Button>
        <Button asChild><Link to={source ? generatorRevisionPath(source) : generatorsPath}>取消</Link></Button>
      </div>
    </fieldset></form>
  </div>
}
