import { useState, type FormEvent } from 'react'
import { Bot, Wrench } from 'lucide-react'
import { Link } from 'react-router'
import { ArtifactFiles } from '@/modules/agent-executor/ArtifactFiles'
import { executorRevisions, type ExecutorRef } from '@/shared/api/agent-executor'
import { useResource } from '@/shared/hooks/use-resource'
import { requestV2 } from '@/shared/http/client'
import { Button } from '@/shared/ui/button'
import { Conversation, ConversationContent, ConversationEmptyState, Message, MessageContent, MessageResponse,
  PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '../ai-elements'
import { useAttempt } from './use-attempt'

type Executor = ExecutorRef & { active: boolean; agent?: object }
const statusLabels = {
  starting: '启动中', running: '运行中', unverified: '待核实', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}
const toolLabels: Record<string, string> = {
  pending: '等待中', in_progress: '运行中', completed: '完成', failed: '失败', cancelled: '取消', paused: '暂停',
}

export default function AgentPage() {
  const catalog = useResource(signal => requestV2<Executor[]>('/executors', { signal }), [] as Executor[])
  const choices = catalog.data.filter(item => item.active && item.agent)
  const [chosen, choose] = useState('')
  const executor = choices.find(item => item.id === chosen) ?? choices[0]
  const attempt = useAttempt()
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const active = attempt.phase === 'observing' || attempt.phase === 'submitting'
  const outcome = attempt.result?.status
  const status = attempt.phase === 'unconfirmed' ? '待核实' : outcome ? statusLabels[outcome]
    : attempt.phase === 'submitting' ? '正在提交' : attempt.id ? '正在查询' : '未提交'

  function submit(ref: ExecutorRef) {
    setSent(draft)
    attempt.start(ref, draft)
  }

  function reset() {
    attempt.reset()
    setConfirmReset(false)
    setDraft('')
    setSent('')
  }

  return <section aria-labelledby="agent-title" className="mx-auto flex w-full max-w-4xl flex-1 flex-col">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <h1 id="agent-title" className="flex items-center gap-2 text-xl font-semibold"><Bot className="size-5" aria-hidden="true" />Agent 工作区</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-txt3">ACP v2</span>
        <span role="status" className={outcome === 'failed' ? 'text-err' : 'font-medium text-txt2'}>{status}</span>
        {(attempt.phase === 'settled' || attempt.phase === 'unconfirmed') && <Button type="button" size="sm" icon="plus" disabled={attempt.cancelling}
          onClick={() => attempt.phase === 'unconfirmed' ? setConfirmReset(true) : reset()}>新建尝试</Button>}
      </div>
    </header>

    <Conversation className="min-h-64 max-h-[60dvh]" aria-label="执行轨迹">
      <ConversationContent className="min-h-64 gap-5">
        {!attempt.id && <ConversationEmptyState icon={<Bot className="size-6" aria-hidden="true" />} title="新任务"
          description={catalog.loading ? '正在读取执行器' : executor ? '等待指令' : '暂无已发布的 Agent'} />}
        {sent && attempt.id && <Message from="user"><span className="text-xs text-txt3">你</span><MessageContent className="whitespace-pre-wrap break-words">{sent}</MessageContent></Message>}
        {attempt.entries.map(entry => entry.kind === 'message'
          ? <Message key={`message:${entry.id}`} from="assistant"><span className="text-xs text-txt3">Agent</span><MessageContent className="break-words"><MessageResponse>{entry.text}</MessageResponse></MessageContent></Message>
          : <div key={`tool:${entry.id}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-txt2">
            <Wrench className="size-4 shrink-0" aria-hidden="true" /><code className="break-all">{entry.name ?? '工具'}</code>
            <span className="text-txt3">{entry.status && Object.hasOwn(toolLabels, entry.status) ? toolLabels[entry.status] : '状态未知'}</span>
          </div>)}
        {attempt.gaps.length > 0 && <p className="text-sm text-warn">部分轨迹未能记录。</p>}
        {active && <p className="text-sm text-txt3">{attempt.cancelRequested ? '已请求停止，等待确认。' : '等待 Agent 更新…'}</p>}
        {attempt.result?.artifactError && <p role="alert" className="text-sm text-err">制品未通过校验。</p>}
        {attempt.result?.artifactDirectoryId && <ArtifactFiles key={attempt.result.artifactDirectoryId} id={attempt.result.artifactDirectoryId} />}
      </ConversationContent>
    </Conversation>

    <div className="mt-auto space-y-3 border-t border-line pt-4">
      {catalog.error && <p role="alert" className="text-sm text-err">{catalog.error} <Button type="button" size="sm" onClick={catalog.reload}>重新读取</Button></p>}
      {attempt.id && <p className="break-all text-xs text-txt3">尝试 ID：<code>{attempt.id}</code></p>}
      {attempt.error && <p role="alert" className="whitespace-pre-line text-sm text-err">{attempt.error}</p>}
      {(attempt.phase === 'unconfirmed' || (attempt.id && attempt.error && outcome)) && <Button type="button" size="sm" icon="refresh" onClick={attempt.retry}>重新查询</Button>}
      {confirmReset && attempt.phase === 'unconfirmed' && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-warn">
        原任务可能仍在运行。新建尝试不会停止它。
        <Button type="button" size="sm" onClick={reset}>确认新建</Button>
        <Button type="button" size="sm" onClick={() => setConfirmReset(false)}>保留原尝试</Button>
      </div>}
      {!catalog.loading && !catalog.error && !executor && <Link to="/executors/new?mode=agent" className="text-sm text-accent-2 underline">创建 Agent 执行器</Link>}
      <Composer key={executor?.id} executor={executor} choices={choices} choose={choose} locked={!!attempt.id}
        draft={draft} setDraft={setDraft} onSubmit={submit}
        stop={outcome === 'running' || outcome === 'starting' ? attempt.cancel : undefined}
        stopDisabled={attempt.cancelling || attempt.cancelRequested} />
    </div>
  </section>
}

function Composer({ executor, choices, choose, locked, draft, setDraft, onSubmit, stop, stopDisabled }: {
  executor?: Executor; choices: Executor[]; choose: (id: string) => void; locked: boolean;
  draft: string; setDraft: (value: string) => void; onSubmit: (ref: ExecutorRef) => void;
  stop?: () => void; stopDisabled: boolean;
}) {
  const [revision, setRevision] = useState<number>()
  const history = useResource(signal => executor ? executorRevisions(executor.id, signal) : Promise.resolve([]), [])
  const revisions = history.data.filter(item => item.agent && item.id === executor?.id)
  const selected = revisions.find(item => item.revision === (revision ?? executor?.revision)) ?? revisions[0]
  const canSend = !locked && !!selected && !!draft.trim() && new TextEncoder().encode(draft).length <= 256 * 1024
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (canSend && selected) onSubmit({ id: selected.id, revision: selected.revision })
  }
  return <PromptInput onSubmit={send}>
    <PromptInputTextarea aria-label="任务指令" value={draft} onChange={event => setDraft(event.target.value)} disabled={locked} placeholder="输入任务指令" />
    <PromptInputFooter className="flex-wrap">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        {choices.length > 1 && <select className="input max-w-full" aria-label="Agent 执行器" value={executor?.id ?? ''} disabled={locked} onChange={event => choose(event.target.value)}>
          {choices.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select>}
        <select className="input max-w-full" aria-label="Agent 修订" value={selected?.revision ?? ''} disabled={locked || !selected} onChange={event => setRevision(Number(event.target.value))}>
          {!selected && <option value="">{history.loading ? '读取修订中' : '无可用修订'}</option>}
          {revisions.map(item => <option key={item.revision} value={item.revision}>{item.id} · v{item.revision}</option>)}
        </select>
        {history.error && <Button type="button" size="sm" title={history.error} onClick={history.reload}>重读修订</Button>}
      </div>
      <div className="flex items-center gap-2">
        {stop && <Button type="button" size="sm" icon="stop" disabled={stopDisabled} onClick={stop}>停止</Button>}
        <PromptInputSubmit aria-label="发送" title="发送" disabled={!canSend} />
      </div>
    </PromptInputFooter>
  </PromptInput>
}
