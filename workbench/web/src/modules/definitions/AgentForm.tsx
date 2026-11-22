import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AttemptPanel } from '@/modules/agent-executor/AttemptPanel'
import { listConfigPackageChoices, listPatches } from '@/modules/patches/api'
import { patchListPath, patchPath } from '@/modules/patches/PatchModel'
import type { AgentConfig } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { BackendChoice } from './BackendChoice'
import { useBackendMatch } from './use-backend-match'
import { Choice, TextField } from './Fields'
import { agentDefinition, type Draft } from './draft'

type Props = {
  draft: Draft & { agent: AgentConfig }; revision?: number; busy: boolean
  change: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  publish: () => Promise<void>; cancel: ReactNode
}

export function AgentForm({ draft: d, revision, busy, change, publish, cancel }: Props) {
  const packages = useResource(listConfigPackageChoices, [])
  const standalone = import.meta.env.URSI_EXECUTOR_CONSOLE
  const samples = useResource(signal => standalone ? Promise.resolve([]) : listPatches('work', signal), [])
  const [sample, setSample] = useState('')
  const { configPackageId, backendId } = d.agent
  const selected = packages.data.find(p => p.id === configPackageId)
  const packageId = (!packages.loading && !packages.error && selected?.id) || ''
  const match = useBackendMatch(packageId)
  const soleId = match.choices.length === 1 ? match.choices[0].id : ''
  useEffect(() => {
    // 不静默替换已失效的旧选择；用户可以重新检查它或明确改选。
    if (soleId && !backendId) change('agent', { configPackageId, backendId: soleId })
  }, [soleId, backendId, configPackageId, change])
  const ready = !!d.id.trim() && !!packageId && match.choices.some(b => b.id === backendId)
  return <div className="page-stack">
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <TextField label="执行器 ID" value={d.id} change={v => change('id', v)} required readOnly={!!revision} />
      <Choice label="配置包" required value={selected?.id ?? ''} change={id => change('agent', { configPackageId: id, backendId: '' })} options={[
        ['', '选择配置包'], ...packages.data.map(({ id, name }) => [id, name] as const),
      ]} />
      {packages.loading ? <p role="status">正在读取配置包…</p> : packages.error ? <p role="alert">{packages.error} <Button onClick={packages.reload}>重读配置包</Button></p> : <>
        {configPackageId && !selected && <p role="alert">原配置包已不可用，请重新选择。</p>}
        {selected ? <Link className="text-accent-2" to={patchPath('config', selected.id)}>编辑配置包</Link> : !packages.data.length &&
          <p role="status">暂无配置包。<Link className="text-accent-2" to={patchListPath('config')}>前往创建配置包</Link></p>}
      </>}
      {packageId && <BackendChoice match={match} id={backendId} change={id => change('agent', { configPackageId, backendId: id })} />}
    </fieldset>
    <div className="space-y-3">
      {!standalone && <Choice label="样例工作包（可选）" value={sample} change={setSample} options={[
        ['', '不使用工作包'], ...samples.data.map(({ id, name }) => [id, name] as const),
      ]} />}
      {samples.error && <p role="alert">{samples.error} <Button onClick={samples.reload}>重读工作包</Button></p>}
      <AttemptPanel target={ready ? { previewDefinition: agentDefinition(d.id, d.agent) } : null} workPatchId={sample || undefined} />
    </div>
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!ready} loading={busy} onClick={publish}>{revision ? '发布新版' : '发布执行器'}</Button>{cancel}</div>
  </div>
}
