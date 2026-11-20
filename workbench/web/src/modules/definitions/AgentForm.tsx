import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AttemptPanel } from '@/modules/agent-executor/AttemptPanel'
import { listPatches } from '@/modules/patches/api'
import { agentOptions, type AgentConfig, type AgentDefinition } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { Choice, Hint, ResourceRefs, TextField } from './Fields'
import type { Latest } from './catalog'
import type { Draft } from './draft'

type Props = {
  draft: Draft & { agent: AgentConfig }; resources: Latest[]; revision?: number; busy: boolean
  change: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  publish: () => Promise<void>; cancel: ReactNode
}

export function AgentForm({ draft: d, resources, revision, busy, change, publish, cancel }: Props) {
  const options = useResource(agentOptions, null)
  const samples = useResource(signal => listPatches('work', signal), [])
  const [sample, setSample] = useState('')
  const [verified, setVerified] = useState(() => new Map<string, number[]>())
  const verify = useCallback((id: string, revisions: number[]) => setVerified(old => new Map(old).set(id, revisions)), [])
  const a = d.agent
  const set = (value: Partial<AgentConfig>) => change('agent', { ...a, ...value })
  const models = options.data?.models ?? []
  const tools = options.data?.tools ?? []
  const allowedTools = new Set(tools.map(v => v.id))
  const revoked = a.tools.filter(id => !allowedTools.has(id))
  const skillChoices = resources.filter(v => ('kind' in v && v.kind === 'skill') || d.resources.some(r => r.id === v.id))
  const skillsReady = d.resources.every(r => resources.some(v => v.id === r.id && v.active) && verified.get(r.id)?.includes(r.revision))
  const duplicate = new Set(d.resources.map(r => r.id)).size !== d.resources.length
  const currentModel = models.some(v => v.id === a.modelProfile)
  const ready = !!d.id.trim() && !!a.systemPrompt.trim() && !options.loading && !options.error && currentModel && !revoked.length && skillsReady && !duplicate
  const definition: AgentDefinition = { id: d.id, resources: d.resources, agent: a }
  return <div className="page-stack">
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <TextField label="执行器 ID" value={d.id} change={v => change('id', v)} required readOnly={!!revision} />
      <TextField label="固定指令" value={a.systemPrompt} change={systemPrompt => set({ systemPrompt })} required multiline />
      <ResourceRefs label="Skill 资源" choices={skillChoices} value={d.resources} change={v => change('resources', v)} onVerifiedSkill={verify} />
      {!skillChoices.some(v => v.active) && <Link className="text-accent-2" to="/resources/new">新建 Skill 资源</Link>}
      {duplicate && <p role="alert">每个 Skill 只能选择一个修订。</p>}
      {!skillsReady && <Hint>请选择启用的 Skill 和固定修订。</Hint>}
      <Choice label="受管模型" value={a.modelProfile} change={modelProfile => set({ modelProfile })} options={[
        ['', '选择模型'], ...models.map(({ id }) => [id, id] as const),
      ]} />
      <fieldset className="space-y-2"><legend className="field-label">获准工具</legend>
        {tools.map(({ id }) => <label key={id} className="mr-4 inline-flex items-center gap-2 break-all">
          <input type="checkbox" checked={a.tools.includes(id)} onChange={e => set({ tools: e.target.checked ? [...a.tools, id] : a.tools.filter(t => t !== id) })} />{id}
        </label>)}
        {options.data && !tools.length && <Hint>暂无获准工具，可不使用工具运行。</Hint>}
      </fieldset>
      {options.loading ? <p role="status">正在读取模型和工具…</p> : options.error ? <p role="alert">{options.error} <Button onClick={options.reload}>重试读取选项</Button></p> : <>
        {!models.length && <p role="status">暂无受管模型，请联系管理员配置。</p>}
        {a.modelProfile && !currentModel && <p role="alert">模型 {a.modelProfile} 已不可用，请重新选择。</p>}
        {!!revoked.length && <p role="alert">工具已不可用：{revoked.join('、')} <Button onClick={() => set({ tools: a.tools.filter(id => allowedTools.has(id)) })}>移除不可用工具</Button></p>}
      </>}
    </fieldset>
    <details className="border-y border-line py-3"><summary className="cursor-pointer font-medium">预览执行器配置</summary>
      <dl className="mt-3 grid gap-2 break-words text-sm"><div><dt className="field-label">执行器</dt><dd>{d.id || '未填写'}</dd></div>
        <div><dt className="field-label">系统提示词</dt><dd className="whitespace-pre-wrap">{a.systemPrompt || '未填写'}</dd></div>
        <div><dt className="field-label">Skill 修订</dt><dd>{d.resources.map(r => `${r.id || '未选择'} @${r.revision || '?'}`).join('、') || '无'}</dd></div>
        <div><dt className="field-label">模型与工具</dt><dd>{a.modelProfile || '未选择模型'} · {a.tools.join('、') || '无工具'}</dd></div>
      </dl>
    </details>
    <div className="space-y-3">
      <Choice label="样例工作包（可选）" value={sample} change={setSample} options={[
        ['', '不使用工作包'], ...samples.data.map(({ id, name }) => [id, name] as const),
      ]} />
      {samples.error && <p role="alert">{samples.error} <Button onClick={samples.reload}>重读工作包</Button></p>}
      <AttemptPanel target={ready ? { previewDefinition: definition } : null} workPatchId={sample || undefined} />
    </div>
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!ready} loading={busy} onClick={publish}>{revision ? '发布新版' : '发布执行器'}</Button>{cancel}</div>
  </div>
}
