import { type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { VersionList } from './Sops'
import { editPath, executorInfo, executorName, findVersion, historyPath, latestOf, listSops, sopTitle, type SopVersion } from './model'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="field-label">{label}</dt><dd className="mt-1 break-words">{children}</dd></div>
}

export function SopVersionPage() {
  const { id = '', revision = '' } = useParams()
  const result = useResource(listSops, [] as SopVersion[])
  const version = findVersion(result.data, id, revision)
  const latest = latestOf(result.data, id)

  if (result.loading || result.error) return <div className="page-stack">
    <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  </div>

  if (!version || !latest) return <div className="page-stack break-words">
    <PageHeader title="未找到该 SOP 修订" description={`${id} v${revision}`} />
    <ResourceState empty title="未找到该 SOP 修订" description="该标识或修订不存在。已发布的修订不会被删除，请核对地址或回到目录重新选择。">
      <Button asChild><Link to={historyPath(id)}>查看该 SOP 的修订</Link></Button>
    </ResourceState>
  </div>

  const info = executorInfo(version.executor)
  return <div className="page-stack max-w-3xl break-words">
    <PageHeader title={sopTitle(version)} description={`${version.id} v${version.revision} · 执行器 ${executorName(version.executor)}`}
      actions={<>
        <Button asChild><Link to={historyPath(version.id)}>历史版本</Link></Button>
        <Button variant="primary" asChild><Link to={editPath(version)}>从此版发布新版</Link></Button>
      </>} />
    <section className="panel space-y-5 p-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label="SOP 标识">{version.id}</Fact>
        <Fact label="修订">v{version.revision}</Fact>
        <Fact label="执行器">{executorName(version.executor)}</Fact>
        <Fact label="回执标题">{sopTitle(version)}</Fact>
      </dl>
      <p className="text-sm leading-6 text-txt3">{info.titleHint}</p>
      <p className="text-sm leading-6 text-txt3">
        {version.revision === latest.revision ? '这是该 SOP 的最新修订。' : `这是已冻结的历史修订，该 SOP 最新为 v${latest.revision}。查看旧版不会改变任何工作区的绑定。`}
        发布新版只会追加修订，不修改这一版；已绑定该版的工作区继续使用原修订。
      </p>
    </section>
  </div>
}

export function SopHistory() {
  const { id = '' } = useParams()
  const result = useResource(listSops, [] as SopVersion[])
  const versions = result.data.filter(version => version.id === id).sort((a, b) => b.revision - a.revision)

  if (result.loading || result.error) return <div className="page-stack">
    <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />
  </div>

  if (!versions.length) return <div className="page-stack break-words">
    <PageHeader title="SOP 修订" description={id} />
    <ResourceState empty title="该 SOP 还没有已发布修订" description="核对标识后重新打开，或发布一个新的 SOP。" >
      <Button variant="primary" asChild><Link to="/sops/new">发布 SOP</Link></Button>
    </ResourceState>
  </div>

  const latest = versions[0]!
  return <div className="page-stack break-words">
    <PageHeader title={sopTitle(latest)} description={`${latest.id} · 共 ${versions.length} 个修订`}
      actions={<>
        <Button asChild><Link to="/sops">返回 SOP 目录</Link></Button>
        <Button variant="primary" asChild><Link to={editPath(latest)}>从最新版发布新版</Link></Button>
      </>} />
    <p className="text-sm text-txt3">修订按从新到旧排列。任一版都可以打开查看冻结配置，并从该版发布新版。</p>
    <VersionList versions={versions} latest={latest.revision} />
  </div>
}
