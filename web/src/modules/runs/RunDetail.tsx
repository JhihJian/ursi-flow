import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { runtime, errorMessage } from '@/shared/api'
import type { Run, RunHistory } from '@/shared/api/types'
import { useResource } from '@/shared/hooks/use-resource'
import { confirmAction } from '@/shared/stores/feedback'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'

export function RunDetail() {
  const { id } = useParams()
  return <Detail key={id} id={id!} />
}
function Detail({ id }: { id: string }) {
  const job = useResource<Run | null>(s => runtime.run(id, s), null)
  const history = useResource<RunHistory | null>(s => runtime.history(id, s), null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { reload: reloadJob } = job
  const { reload: reloadHistory } = history
  useEffect(() => {
    if (busy || job.loading || history.loading || job.error || history.error || job.data?.status !== 'running') return
    const timer = setTimeout(() => { reloadJob(); reloadHistory() }, 3000)
    return () => clearTimeout(timer)
  }, [busy, job.loading, history.loading, job.error, history.error, job.data, reloadJob, reloadHistory])
  async function stop() {
    if (!await confirmAction({ title: '停止运行？', description: `请求停止运行 ${id}。`, danger: true, confirmLabel: '停止' })) return
    setBusy(true); setError('')
    try { await runtime.stop(id); reloadJob(); reloadHistory() } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="page-stack"><PageHeader title="运行详情" actions={<><Button asChild><Link to="/runs">返回列表</Link></Button><Button icon="refresh" disabled={job.loading || history.loading} onClick={() => { reloadJob(); reloadHistory() }}>刷新</Button></>} />
    <ResourceState loading={!job.data && job.loading} error={job.error} onRetry={reloadJob} />
    {job.data && <section className="panel space-y-4 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="break-all font-semibold">{job.data.id}</h2><span className="text-sm">状态：{job.data.status}</span></div>
      <p className="break-all text-sm">Flow：<Link className="text-accent-2" to={`/flows/${encodeURIComponent(job.data.flow)}/edit`}>{job.data.flow}</Link></p>
      <details><summary className="cursor-pointer text-sm">运行参数与配置</summary><Json value={job.data} /></details>
      {job.data.error && <p role="alert" className="break-words text-err">{job.data.error}</p>}
      {job.data.status === 'running' && <Button variant="danger" loading={busy} onClick={() => void stop()}>停止 Run</Button>}
      {error && <p role="alert" className="text-sm text-err">{error}</p>}
    </section>}
    <h2 className="font-semibold">运行历史</h2><ResourceState loading={!history.data && history.loading} error={history.error} onRetry={reloadHistory} />
    {history.data && <section className="panel divide-y divide-line">{Object.entries(history.data).filter(([key]) => key !== 'job').map(([key, value]) => <details key={key} className="p-4" open><summary className="cursor-pointer text-sm font-medium">{key}{Array.isArray(value) && ` (${value.length})`}</summary><Json value={value} /></details>)}</section>}
  </div>
}
function Json({ value }: { value: unknown }) {
  return <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-base p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
}
