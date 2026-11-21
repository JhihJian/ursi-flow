import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { directoryClient } from '@/modules/directories/api'
import { ReadOnlyFile } from '@/modules/directories/ReadOnlyFile'
import { patchPath } from '@/modules/patches/PatchModel'
import { workItemPath } from '@/shared/api/work-items'
import {
  generationHistoryPath, generationRunPath, generatorRevisionPath, generatorsPath, getGenerationRun, listGenerationRuns,
  type GenerationFilters, type GenerationRun,
} from '@/shared/api/work-patch-generators'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

const labels: Record<GenerationRun['status'], string> = { running: '运行中', succeeded: '成功', failed: '失败', interrupted: '已中断' }
const link = 'break-all text-accent-2 hover:underline'
const pollMs = 1500

function Time({ ms }: { ms: number }) {
  const date = new Date(ms)
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
}

export function GenerationRuns() {
  const [params, setParams] = useSearchParams()
  const filters = { generatorId: params.get('generatorId') ?? '', workItemId: params.get('workItemId') ?? '' }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const next = new URLSearchParams()
    for (const key of ['generatorId', 'workItemId']) {
      const value = String(fields.get(key) ?? '').trim()
      if (value) next.set(key, value)
    }
    setParams(next)
  }
  return <div className="page-stack">
    <PageHeader title="生成记录" actions={<Button asChild><Link to={generatorsPath}>工作包生成器</Link></Button>} />
    <form key={generationHistoryPath(filters)} onSubmit={apply} className="flex flex-wrap items-end gap-3 text-sm">
      <label>生成器 ID<Input name="generatorId" defaultValue={filters.generatorId} /></label>
      <label>工作项 ID<Input name="workItemId" defaultValue={filters.workItemId} /></label>
      <Button type="submit">筛选</Button>
      <Button asChild variant="ghost"><Link to={generationHistoryPath()}>清除筛选</Link></Button>
    </form>
    <RunList key={generationHistoryPath(filters)} filters={filters} />
  </div>
}

function RunList({ filters }: { filters: GenerationFilters }) {
  const runs = useResource(signal => listGenerationRuns(filters, signal), [])
  return <>
    <ResourceState loading={runs.loading} error={runs.error} onRetry={runs.reload} empty={!runs.data.length}
      title={runs.error ? undefined : '暂无生成记录'} />
    {!runs.loading && !runs.error && runs.data.length > 0 && <>
      <p className="text-sm text-txt3">最多显示最近 100 条记录。</p>
      <ul className="divide-y divide-line">
        {runs.data.map(run => <li key={run.id} className="grid gap-1 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Link className={link} to={generationRunPath(run.id)}>{run.result?.name ?? run.workItemTitle ?? run.generator.id}</Link>
            <span className="font-medium">{labels[run.status]}</span><Time ms={run.startedAt} />
          </div>
          <p className="break-all text-txt3">{run.workItemId ? '工作项生成' : '试运行'} · {run.generator.id} · 第 {run.generator.revision} 版 · {run.id}</p>
        </li>)}
      </ul>
    </>}
  </>
}

export function GenerationRunDetail() {
  const { id = '' } = useParams()
  return <RunDetail key={id} id={id} />
}

function RunDetail({ id }: { id: string }) {
  const { data, loading, error, reload } = useResource(signal => getGenerationRun(id, signal), null)
  const running = data?.status === 'running'
  useEffect(() => {
    if (!running || loading || error) return
    const timer = window.setTimeout(reload, pollMs)
    return () => window.clearTimeout(timer)
  }, [running, loading, error, reload])
  return <div className="page-stack max-w-4xl">
    <PageHeader title="生成详情" actions={<Button asChild><Link to={generationHistoryPath()}>返回生成记录</Link></Button>} />
    <p className="break-all text-sm text-txt3">{id}</p>
    <ResourceState loading={loading && !data} error={error} onRetry={reload} />
    {data && <RunSnapshot run={data} />}
  </div>
}

function RunSnapshot({ run }: { run: GenerationRun }) {
  return <>
    <dl className="grid gap-y-2 break-words text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt>状态</dt><dd role="status" className="font-medium">{labels[run.status]}</dd>
      <dt>生成器版本</dt><dd><Link className={link} to={generatorRevisionPath(run.generator)}>{run.generator.id} · 第 {run.generator.revision} 版</Link></dd>
      <dt>发起方式</dt><dd>{run.workItemId ? <Link className={link} to={workItemPath(run.workItemId)}>{run.workItemTitle || run.workItemId}</Link> : '试运行'}</dd>
      {run.initiator && <><dt>发起身份</dt><dd>工作台管理员（共享令牌）</dd></>}
      <dt>开始时间</dt><dd><Time ms={run.startedAt} /></dd>
      {run.finishedAt != null && <><dt>结束时间</dt><dd><Time ms={run.finishedAt} /></dd></>}
    </dl>
    {run.error && <section className="space-y-2 border-t border-line pt-3" aria-label="失败原因">
      <h2 className="font-semibold">失败原因</h2><p className="whitespace-pre-wrap break-words text-sm text-err">{run.error.stage}：{run.error.message}</p>
    </section>}
    <section className="space-y-2 border-t border-line pt-3" aria-label="输入资源">
      <h2 className="font-semibold">输入资源</h2>
      {run.resources.length ? <ul className="space-y-2 break-all text-sm">{run.resources.map(ref => {
        const read = run.evidence?.find(e => e.alias === ref.alias)
        return <li key={ref.alias}><strong>{ref.alias}</strong> · {ref.serverId} · {ref.uri}
          {read && <p className="text-txt3">SHA-256：{read.sha256} · 读取于 <Time ms={read.readAt} /></p>}
        </li>
      })}</ul> : <p className="text-sm text-txt3">无输入资源</p>}
    </section>
    {run.status === 'succeeded' && run.result && <Result key={run.result.directoryId} result={run.result} />}
  </>
}

function Result({ result }: { result: NonNullable<GenerationRun['result']> }) {
  const { files, workPatchId, directoryId } = result
  const [selected, select] = useState<string | null>(null)
  return <section className="space-y-3 border-t border-line pt-3" aria-label="生成结果">
    <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">生成结果</h2><p className="break-all text-sm">{result.name}</p>
      {workPatchId && <Button asChild size="sm"><Link to={patchPath('work', workPatchId)}>打开工作包</Link></Button>}
    </div>
    <h3 className="text-sm font-medium">{workPatchId ? '生成时的文件清单' : '结果文件（只读）'}</h3>
    {files.length ? <ul className="divide-y divide-line text-sm">{files.map(file => <li key={file.path} className="space-y-1 py-2">
      {workPatchId ? <span className="break-all">{file.path}</span> : <button type="button" aria-pressed={selected === file.path}
        className={`${link} text-left underline`} onClick={() => select(file.path)}>{file.path}</button>}
      <p className="break-all text-xs text-txt3">{file.bytes} B · SHA-256：{file.sha256}</p>
    </li>)}</ul> : <p className="text-sm text-txt3">暂无结果文件</p>}
    {!workPatchId && selected !== null && <ReadOnlyFile key={selected} directory={directoryClient(directoryId)} path={selected} />}
  </section>
}
