import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ChevronRight, CircleStop, History, Network, Terminal } from 'lucide-react'
import { AsyncState, Refresh, Status, message, useLoad } from './main'
import type { NodeRun, RunHistory, Source } from './data'

const when = (value?: string) => {
  if (!value) return '·'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false })
}
const duration = (start: string, end?: string) => {
  if (!end) return '·'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '·'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
const nodeLabel = (run: NodeRun) => `${run.nodeName || run.nodeRef}`
const refName = (history: RunHistory, nodeRunId: string) => {
  const found = history.nodeRuns.find((run) => run.id === nodeRunId)
  return found ? nodeLabel(found) : nodeRunId
}
const json = (value: unknown) => JSON.stringify(value ?? null, null, 2)

export function Runs({ source }: { source: Source }) {
  const state = useLoad((signal) => source.runs(signal), [source])
  const rows = state.value || []
  const running = rows.filter((row) => row.status === 'running').length
  return (
    <main>
      <div className="heading">
        <div>
          <h1>运行记录</h1>
          <small>
            {rows.length} 条记录{running > 0 && ` · ${running} 条运行中`}
          </small>
        </div>
        <Refresh state={state} />
      </div>
      {!state.value ? (
        <AsyncState state={state} />
      ) : !rows.length ? (
        <div role="status" className="empty">
          <History />
          暂无运行记录
          <Link className="button" to="/flows">
            从 Flow 包发起运行
          </Link>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Run ID', 'Flow', '状态', '修订', '工作目录', ''].map((cell) => (
                  <th key={cell}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="identity">
                    <Link to={`/runs/${encodeURIComponent(row.id)}`}>
                      <b>{row.id}</b>
                    </Link>
                  </td>
                  <td>
                    <Link to={`/flows/${encodeURIComponent(row.flow)}/edit`}>{row.flow}</Link>
                  </td>
                  <td>
                    <Status status={row.status} />
                  </td>
                  <td className="mono" data-label="修订">
                    {row.revision.slice(0, 8)}
                  </td>
                  <td className="mono" data-label="工作目录">
                    {row.cwd}
                  </td>
                  <td className="action">
                    <Link
                      to={`/runs/${encodeURIComponent(row.id)}`}
                      aria-label={`查看运行 ${row.id}`}
                      title="查看详情"
                    >
                      <ChevronRight size={17} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

// facts.json 在运行尚未提交任何事实时可能缺少集合字段，界面按空集合处理。
function normalize(history: RunHistory): RunHistory {
  return {
    ...history,
    runs: history.runs ?? [],
    nodeRuns: history.nodeRuns ?? [],
    routeDecisions: history.routeDecisions ?? [],
    parallelRounds: history.parallelRounds ?? [],
    recoveries: history.recoveries ?? [],
  }
}

export function RunDetail({ source }: { source: Source }) {
  const id = useParams<'id'>().id!
  const job = useLoad((signal) => source.run(id, signal), [source, id])
  const history = useLoad((signal) => source.history(id, signal), [source, id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const { refresh: reloadJob } = job
  const { refresh: reloadHistory } = history
  useEffect(() => {
    if (job.value?.status !== 'running' || busy) return
    const timer = setTimeout(() => {
      reloadJob()
      reloadHistory()
    }, 3000)
    return () => clearTimeout(timer)
  }, [job.value, busy, reloadJob, reloadHistory])
  const stop = async () => {
    setBusy(true)
    setError('')
    setConfirm(false)
    try {
      await source.stop(id)
      reloadJob()
      reloadHistory()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const facts = history.value ? normalize(history.value) : undefined
  const run = facts?.runs.find((item) => item.id === id)
  const children = (facts?.runs || []).filter((item) => item.id !== id)
  const jobRow = job.value
  return (
    <main>
      <Link className="back" to="/runs">
        <ArrowLeft size={16} />
        运行记录
      </Link>
      {!jobRow ? (
        <AsyncState state={job} />
      ) : (
        <>
          <div className="heading">
            <div>
              <h1>{jobRow.id}</h1>
              <small>
                Flow {jobRow.flow} · 修订 {jobRow.revision.slice(0, 8)} · {when((run?.startedAt as string) || undefined)}
              </small>
            </div>
            <Status status={jobRow.status} />
            <Refresh state={job} />
            {jobRow.status === 'running' && (
              <button onClick={() => setConfirm(true)} disabled={busy}>
                <CircleStop />
                停止运行
              </button>
            )}
          </div>
          {confirm && (
            <p className="warning" role="alert">
              停止会向该运行的进程组发送终止信号，已提交的节点事实保留。
              <button onClick={() => setConfirm(false)}>取消</button>
              <button onClick={stop}>确认停止</button>
            </p>
          )}
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
          {jobRow.error && (
            <p role="alert" className="warning">
              运行失败：{jobRow.error}
            </p>
          )}
          <section>
            <h2>运行参数</h2>
            <dl className="facts">
              {Object.entries({
                状态: jobRow.status,
                阶段: (run?.phase as string) || '·',
                工作目录: jobRow.cwd,
                修订: jobRow.revision,
                并发上限: String(jobRow.config.maxConcurrent),
                模型: jobRow.config.model || '执行器默认模型',
              }).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>启动变量</summary>
              <pre>{json(jobRow.variables)}</pre>
            </details>
          </section>
          <section>
            <div className="tools">
              <h2>节点时间线</h2>
              <small>{facts ? `${facts.nodeRuns.length} 次访问` : '读取中…'}</small>
            </div>
            {!facts ? (
              <AsyncState state={history} />
            ) : !facts.nodeRuns.length ? (
              <p className="muted">还没有节点执行记录。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {['#', '节点', '动作', '状态', '结果', '耗时', ''].map((cell) => (
                        <th key={cell}>{cell}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {facts.nodeRuns.map((node) => (
                      <NodeRow
                        key={node.id}
                        node={node}
                        open={open === node.id}
                        toggle={() => setOpen(open === node.id ? null : node.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <div className="tools">
              <h2>
                <Network />
                路由证据
              </h2>
              <small>{facts ? `${facts.routeDecisions.length} 次选择` : '读取中…'}</small>
            </div>
            {facts && facts.routeDecisions.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {['#', '来源节点', '结果', '去向', '选择时间'].map((cell) => (
                        <th key={cell}>{cell}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {facts.routeDecisions.map((decision) => (
                      <tr key={decision.id}>
                        <td className="mono">{decision.sequence}</td>
                        <td>{refName(facts, decision.sourceNodeRunId)}</td>
                        <td>{decision.result}</td>
                        <td>
                          {decision.destination.kind === 'finish'
                            ? '结束'
                            : decision.destination.ref || decision.destination.kind}
                        </td>
                        <td>{when(decision.selectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {facts && facts.routeDecisions.length === 0 && (
              <p className="muted">还没有路由记录。</p>
            )}
          </section>
          {children.length > 0 && (
            <section>
              <h2>子 Run</h2>
              <ul className="list">
                {children.map((child) => (
                  <li key={child.id}>
                    <Link to={`/runs/${encodeURIComponent(child.id)}`}>
                      <span className="identity">
                        <b>{child.id}</b>
                        <small>
                          {child.flowId} · {child.status}
                        </small>
                      </span>
                      <ChevronRight size={16} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {facts && facts.parallelRounds.length > 0 && (
            <section>
              <h2>并行轮次</h2>
              <ul className="evidence">
                {facts.parallelRounds.map((round) => (
                  <li key={round.id}>
                    <b>{round.parallelRef}</b>
                    <Status status={round.status} />
                    <small>
                      {Object.entries(round.branchStatuses)
                        .map(([branch, status]) => `${branch}: ${status}`)
                        .join(' · ')}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {facts && facts.recoveries.length > 0 && (
            <section>
              <h2>恢复记录</h2>
              <ul className="evidence">
                {facts.recoveries.map((recovery) => (
                  <li key={recovery.id}>
                    <b>{recovery.strategy}</b>
                    <span>{recovery.summary}</span>
                    <small>{when(recovery.resumedAt)}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {facts && (
            <details>
              <summary>原始事实</summary>
              <pre>{json({ ...facts, job: undefined })}</pre>
            </details>
          )}
        </>
      )}
    </main>
  )
}

function NodeRow({
  node,
  open,
  toggle,
}: {
  node: NodeRun
  open: boolean
  toggle: () => void
}) {
  return (
    <>
      <tr>
        <td className="mono">{node.sequence}</td>
        <td>
          <b>{nodeLabel(node)}</b>
          <small className="block mono">{node.nodeRef}</small>
        </td>
        <td>{node.actionKind}</td>
        <td>
          <Status status={node.status} />
        </td>
        <td>{node.outcome?.result || node.error?.summary || '·'}</td>
        <td>{duration(node.startedAt, node.completedAt)}</td>
        <td className="action">
          <button className="icon" aria-expanded={open} onClick={toggle} title="执行证据">
            <ChevronRight size={17} className={open ? 'rotate-90' : ''} />
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="evidence-cell">
            <div className="evidence-grid">
              <div>
                <h3>输入</h3>
                <pre>{json(node.input)}</pre>
              </div>
              {node.outcome && (
                <div>
                  <h3>结果</h3>
                  <pre>{json(node.outcome)}</pre>
                </div>
              )}
              {node.error && (
                <div>
                  <h3>错误</h3>
                  <pre>{json(node.error)}</pre>
                </div>
              )}
              {node.commandResult && (
                <div className="wide">
                  <h3>
                    <Terminal size={14} />
                    命令输出 · 退出码 {node.commandResult.exitCode ?? '·'}
                  </h3>
                  <pre>{node.commandResult.stdout || '（无标准输出）'}</pre>
                  {node.commandResult.stderr && <pre className="err">{node.commandResult.stderr}</pre>}
                </div>
              )}
              {node.childRunId && (
                <div>
                  <h3>子 Run</h3>
                  <Link to={`/runs/${encodeURIComponent(node.childRunId)}`}>{node.childRunId}</Link>
                </div>
              )}
              <div>
                <h3>来源</h3>
                <pre>{json(node.enteredFrom)}</pre>
              </div>
            </div>
            {node.retryOf && <p className="muted">重试自 {node.retryOf}</p>}
          </td>
        </tr>
      )}
    </>
  )
}
