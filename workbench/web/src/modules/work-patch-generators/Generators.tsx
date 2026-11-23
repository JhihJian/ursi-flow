import { useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  generationHistoryPath, generatorPath, generatorRevisionPath, generatorRevisionsPath, generatorsPath, newGeneratorPath,
  getGenerator, getGeneratorRevision, listGeneratorRevisions, listGenerators, type Generator,
} from '@/shared/api/work-patch-generators'
import type { ResourceRef } from '@/shared/api/work-patch-generators'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { resolveInputs } from './inputs'
import { ResourceInputs } from './ResourceInputs'
import { useStartGeneration } from './use-start-generation'

export function Generators() {
  const catalog = useResource(listGenerators, [])
  return <div className="page-stack">
    <PageHeader title="工作包生成器" actions={<>
      <Button asChild variant="primary"><Link to={newGeneratorPath}>新建生成器</Link></Button>
      <Button asChild><Link to={generationHistoryPath()}>生成记录</Link></Button>
    </>} />
    <ResourceState loading={catalog.loading} error={catalog.error} onRetry={catalog.reload} empty={!catalog.data.length}
      title={catalog.error ? undefined : '暂无生成器'} />
    <ul className="divide-y divide-line">{catalog.data.map(generator => <li key={generator.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
      <Link className="min-w-0 break-all text-accent-2 hover:underline" to={generatorRevisionPath(generator)}>{generator.name}</Link>
      <span className="break-all text-sm text-txt3">{generator.id} · 第 {generator.revision} 版</span>
    </li>)}</ul>
  </div>
}

export function GeneratorHistory() {
  const { id = '' } = useParams()
  return <History key={id} id={id} />
}

function History({ id }: { id: string }) {
  const history = useResource(signal => listGeneratorRevisions(id, signal), [])
  const revisions = [...history.data].sort((a, b) => b.revision - a.revision)
  return <div className="page-stack">
    <PageHeader title="生成器历史版本" actions={<>
      <Button asChild><Link to={generatorsPath}>返回生成器列表</Link></Button>
      <Button asChild><Link to={generationHistoryPath({ generatorId: id })}>生成记录</Link></Button>
    </>} />
    <p className="break-all text-sm text-txt3">{id}</p>
    <ResourceState loading={history.loading} error={history.error} onRetry={history.reload} empty={!revisions.length}
      title={history.error ? undefined : '暂无已发布版本'} />
    <ul className="divide-y divide-line">{revisions.map(generator => <li key={generator.revision} className="flex flex-wrap items-center gap-3 py-3 text-sm">
      <Link className="text-accent-2 hover:underline" to={generatorRevisionPath(generator)}>第 {generator.revision} 版</Link>
      <span className="break-all">{generator.name}</span>
    </li>)}</ul>
  </div>
}

export function GeneratorDetail() {
  const { id = '', revision } = useParams()
  return <Detail key={JSON.stringify([id, revision])} id={id} revision={revision} />
}

function Detail({ id, revision }: { id: string; revision?: string }) {
  const generator = useResource(signal => {
    if (revision === undefined) return getGenerator(id, signal)
    const number = Number(revision)
    if (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(number)) return Promise.reject(new Error('版本号无效。'))
    return getGeneratorRevision({ id, revision: number }, signal)
  }, null)
  const data = generator.data
  return <div className="page-stack max-w-4xl">
    <PageHeader title={data?.name ?? '工作包生成器'} className="break-all [&>h1]:min-w-0 [&>h1]:shrink" actions={<>
      <Button asChild><Link to={generatorRevisionsPath(id)}>历史版本</Link></Button>
      <Button asChild><Link to={generationHistoryPath({ generatorId: id })}>生成记录</Link></Button>
      {data && <Button asChild><Link to={`${generatorPath(id)}/edit`}>发布新版</Link></Button>}
    </>} />
    <ResourceState loading={generator.loading} error={generator.error} onRetry={generator.reload} />
    {data && <>
      <p className="break-all text-sm text-txt3">{data.id} · 第 {data.revision} 版</p>
      <details className="space-y-2 border-y border-line py-3"><summary className="font-medium">Python 脚本</summary>
        <pre className="max-h-96 overflow-auto bg-base p-3 text-sm">{data.script}</pre>
      </details>
      <Trial key={data.revision} generator={data} />
    </>}
  </div>
}

function Trial({ generator }: { generator: Generator }) {
  const [refs, setRefs] = useState<ResourceRef[]>([])
  const resources = resolveInputs(generator.aliases, refs)
  const run = useStartGeneration()
  return <form onSubmit={event => {
    event.preventDefault()
    if (resources) run.start({ generator: { id: generator.id, revision: generator.revision }, resources })
  }}>
    <fieldset disabled={run.busy} className="grid min-w-0 gap-3 text-sm">
      <legend className="mb-3 text-base font-semibold">试运行</legend>
      <ResourceInputs aliases={generator.aliases} refs={refs} onChange={setRefs} />
      {run.error && <p role="alert" className="text-err">{run.error}</p>}
      <div><Button type="submit" variant="primary" loading={run.busy} disabled={!resources}>试运行</Button></div>
    </fieldset>
  </form>
}
