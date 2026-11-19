import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { errorMessage } from '@/shared/api'
import { useResource } from '@/shared/hooks/use-resource'
import { Button } from '@/shared/ui/button'
import { PageHeader } from '@/shared/ui/page-header'
import { ResourceState } from '@/shared/ui/resource-state'
import {
  attemptStatus, downloadReceipt, formatSize, materialOf, readReceipt, readWorkspace,
  runAttempt, sopTitle, workspacePath, type WorkspaceDetail, type WorkspaceSopRef,
} from './model'
import { RunControl } from './RunControl'

export function WorkspaceResult() {
  const { id = '' } = useParams()
  const result = useResource(signal => readWorkspace(id, signal), null)
  return <div className="page-stack break-words">
    <PageHeader title="执行结果" description={result.data ? `${result.data.typeId} · ${id}` : id}
      actions={<>
        <Button asChild><Link to="/workspaces">返回工作包</Link></Button>
        <Button asChild><Link to={workspacePath(id)}>准备工作包</Link></Button>
        <Button icon="refresh" onClick={result.reload} disabled={result.loading}>刷新</Button>
      </>} />
    {result.data
      ? <ResultPanel key={JSON.stringify(result.data)} initial={result.data} />
      : <ResourceState loading={result.loading} error={result.error} onRetry={result.reload} />}
  </div>
}

function ResultPanel({ initial }: { initial: WorkspaceDetail }) {
  const [workspace, setWorkspace] = useState(initial)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [receipt, setReceipt] = useState<{ attempt: string; text: string } | null>(null)
  const [receiptError, setReceiptError] = useState<{ attempt: string; message: string } | null>(null)
  const [receiptBusy, setReceiptBusy] = useState('')
  const receiptController = useRef<AbortController | null>(null)
  const latest = workspace.attempts.at(-1)

  useEffect(() => () => receiptController.current?.abort(), [])
  useEffect(() => {
    if (!latest || latest.status !== 'succeeded') return
    const controller = new AbortController()
    receiptController.current = controller
    void readReceipt(workspace.id, latest.id, controller.signal).then(text => {
      if (!controller.signal.aborted) setReceipt({ attempt: latest.id, text })
    }).catch(cause => {
      if (!controller.signal.aborted) setReceiptError({ attempt: latest.id, message: errorMessage(cause) })
    })
    return () => controller.abort()
  }, [workspace.id, latest])

  async function run(sop: WorkspaceSopRef) {
    if (running) return
    setRunning(true)
    setRunError('')
    try {
      const next = await runAttempt(workspace.id, sop)
      setWorkspace(next)
      setReceipt(null)
      setReceiptError(null)
    } catch (cause) {
      setRunError(`执行请求未完成：${errorMessage(cause)}`)
    } finally {
      setRunning(false)
    }
  }

  async function view(attempt: string) {
    if (receiptBusy) return
    setReceiptBusy(attempt)
    setReceiptError(null)
    receiptController.current?.abort()
    const controller = new AbortController()
    receiptController.current = controller
    try {
      const text = await readReceipt(workspace.id, attempt, controller.signal)
      if (controller.signal.aborted) return
      setReceipt({ attempt, text })
    } catch (cause) {
      if (!controller.signal.aborted) {
        setReceipt(null)
        setReceiptError({ attempt, message: errorMessage(cause) })
      }
    } finally {
      if (!controller.signal.aborted) setReceiptBusy('')
    }
  }

  async function save(attempt: string) {
    if (receiptBusy) return
    setReceiptBusy(attempt)
    setReceiptError(null)
    try {
      await downloadReceipt(workspace.id, attempt)
    } catch (cause) {
      setReceiptError({ attempt, message: errorMessage(cause) })
    } finally {
      setReceiptBusy('')
    }
  }

  return <>
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">需求</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{workspace.requirement}</p>
        </div>
        <span className={workspace.frozen ? 'status-pill status-neutral' : 'status-pill status-ok'}>
          {workspace.frozen ? '已冻结' : '可编辑'}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-sm text-txt2">
        {workspace.roles.map(role => {
          const material = materialOf(workspace, role.id)
          return <li key={role.id} className="break-words">
            {role.label}：{material ? `${material.name}（${formatSize(material.size)}）` : '未上传'}
          </li>
        })}
      </ul>
      {!workspace.frozen && <p className="text-xs text-txt3">
        需要修改需求或材料时回到<Link className="ml-1 text-accent-2 underline" to={workspacePath(workspace.id)}>准备工作包</Link>。
      </p>}
    </section>

    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">执行记录</h2>
          <p className="mt-1 text-sm text-txt2">
            {workspace.attempts.length === 0
              ? '尚未执行'
              : `${workspace.attempts.length} 次执行 · 最近${attemptStatus[latest!.status]}`}
          </p>
        </div>
      </div>
      <RunControl typeId={workspace.typeId} action="再执行一次" running={running} onRun={run} />
      {runError && <p role="alert" className="break-words border-l-2 border-err pl-3 text-sm text-err">{runError}</p>}
      {workspace.attempts.length === 0
        ? <p className="text-sm text-txt2">执行后会在这里留下成功或失败的尝试记录，并生成回执。</p>
        : <ol className="divide-y divide-line border-y border-line">
          {workspace.attempts.map(attempt => <li key={attempt.id} className="space-y-3 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className={attempt.status === 'succeeded' ? 'status-pill status-ok' : 'status-pill status-err'}>
                {attemptStatus[attempt.status]}
              </span>
              <span className="break-all font-mono text-xs text-txt3">{attempt.id}</span>
              <span className="break-words text-sm text-txt2">
                {sopTitle(attempt.sop)} · {attempt.sop.id} v{attempt.sop.revision}
                {attempt.sop.executor ? ` · 执行器 ${attempt.sop.executor}` : ''}
              </span>
              {attempt.status === 'succeeded' && <span className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" loading={receiptBusy === attempt.id && !receiptError}
                  disabled={receiptBusy !== '' && receiptBusy !== attempt.id}
                  aria-label={`查看回执 ${attempt.id}`} onClick={() => void view(attempt.id)}>查看回执</Button>
                <Button size="sm" disabled={receiptBusy !== ''}
                  aria-label={`下载回执 ${attempt.id}`} onClick={() => void save(attempt.id)}>下载回执</Button>
              </span>}
            </div>
            {attempt.error && <p className="break-words text-sm text-err">失败原因：{attempt.error}</p>}
            {receiptError?.attempt === attempt.id &&
              <p role="alert" className="break-words border-l-2 border-err pl-3 text-sm text-err">
                读取回执失败：{receiptError.message}
              </p>}
            {receipt?.attempt === attempt.id && <div className="space-y-1">
              <h3 className="font-medium text-txt2">回执正文</h3>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-sm">{receipt.text}</pre>
            </div>}
          </li>)}
        </ol>}
    </section>
  </>
}
