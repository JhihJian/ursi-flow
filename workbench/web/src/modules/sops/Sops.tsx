import { Link } from 'react-router'
import { useResource } from '@/shared/hooks/use-resource'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import { executorName, groupVersions, historyPath, listSops, newSopPath, revisionPath, sopTitle, type SopGroup, type SopVersion } from './model'

export function VersionList({ versions, latest }: { versions: SopVersion[]; latest: number }) {
  return <ul className="divide-y divide-line border-y border-line">
    {versions.map(version => <li key={version.revision} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
      <Link className="font-medium text-accent-2 hover:underline" to={revisionPath(version)}>{version.id} v{version.revision}</Link>
      <span className="min-w-0 break-words">{sopTitle(version)}</span>
      <span className="text-sm text-txt3">执行器 {executorName(version.executor)}</span>
      {version.revision === latest ? <Badge variant="outline" className="ml-auto">最新</Badge> : <span className="ml-auto text-sm text-txt3">已冻结</span>}
    </li>)}
  </ul>
}

function Group({ group }: { group: SopGroup }) {
  return <section className="space-y-3">
    <header className="flex flex-wrap items-end gap-x-4 gap-y-1">
      <h2 className="min-w-0 break-words text-lg font-semibold">{group.title}</h2>
      <p className="text-sm text-txt3">{group.id} · 共 {group.versions.length} 个修订 · 最新 v{group.latest.revision}</p>
      <Link className="ml-auto text-sm text-accent-2 hover:underline" to={historyPath(group.id)}>浏览修订</Link>
    </header>
    <VersionList versions={group.versions} latest={group.latest.revision} />
  </section>
}

export function Sops() {
  const result = useResource(listSops, [] as SopVersion[])
  const groups = groupVersions(result.data)
  return <section className="page-stack break-words">
    <PageHeader title="SOP 管理" description="查看已发布修订的配置，或从任一版发布新版"
      actions={<Button variant="primary" asChild><Link to={newSopPath}>发布 SOP</Link></Button>} />
    {result.loading || result.error || !groups.length
      ? <ResourceState loading={result.loading} error={result.error} empty
        title={result.error ? '暂时无法读取 SOP 目录' : '暂无已发布 SOP'}
        description={result.error ? undefined : '发布第一个 SOP 版本后会显示在这里。'}
        onRetry={result.reload} />
      : <div className="space-y-6">{groups.map(group => <Group key={group.id} group={group} />)}</div>}
  </section>
}
