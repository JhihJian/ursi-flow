import { useMemo } from 'react'
import type { FlowDetail, RunView } from '../api'
import {
  eventSummary,
  formatTime,
  nodeKindLabel,
  outcomeLabel,
  statusLabel,
  statusTone,
} from '../lib/flow'
import { useFlowStore } from '../store'

/** 运行详情：状态、待决确认、过程事件与变量。 */
export function RunDetail({ run, detail }: { run: RunView; detail?: FlowDetail }) {
  const { busy, confirm, resume, stop } = useFlowStore()
  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of detail?.nodes ?? []) map.set(node.ref, node.name)
    return map
  }, [detail])

  return (
    <section className="flow-run">
      <div className="flow-section-head">
        <span>运行</span>
        <span className={`flow-chip tone-${statusTone(run.status)}`}>
          {statusLabel(run.status)}
        </span>
      </div>
      <code className="flow-run-id" title={run.runId}>
        {run.runId}
      </code>
      <div className="flow-run-meta">
        <span>开始 {formatTime(run.startedAt)}</span>
        <span>步骤 {run.stepCount}</span>
        <span>执行器 {run.executor || '未知'}</span>
        {run.cwd === undefined ? null : <span title={run.cwd}>工作目录 {run.cwd}</span>}
      </div>

      {run.pending === undefined ? null : (
        <div className="flow-gate">
          <div className="flow-gate-head">等待确认 · {run.pending.nodeName}</div>
          <p className="flow-gate-text">{run.pending.message}</p>
          <div className="flow-gate-options">
            {run.pending.options.map((option) => (
              <button
                key={option}
                type="button"
                className="flow-button is-primary"
                disabled={busy === 'confirm'}
                onClick={() => void confirm(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {run.failure === undefined ? null : (
        <p className="flow-error">
          {run.failure.code}：{run.failure.message}
        </p>
      )}

      <div className="flow-run-actions">
        <button
          type="button"
          className="flow-link"
          disabled={run.active || busy !== null}
          onClick={() => void resume()}
          title={run.active ? '运行还在执行' : '从快照继续这次运行'}
        >
          继续
        </button>
        <button
          type="button"
          className="flow-link"
          disabled={run.active || busy !== null || run.status === 'completed'}
          onClick={() => void stop()}
          title={run.active ? '运行还在执行' : '把这次运行标为停止'}
        >
          停止
        </button>
      </div>

      <ol className="flow-events">
        {run.events.map((event) => (
          <li key={`${event.seq}-${event.type}`} className="flow-event">
            <span className="flow-event-seq">{event.seq}</span>
            <span className="flow-event-time">{formatTime(event.at)}</span>
            <span className="flow-event-text">
              {eventSummary(event)}
              {event.nodeRef !== undefined && names.has(event.nodeRef) ? (
                <span className="flow-event-node"> · {names.get(event.nodeRef)}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      {run.status === 'completed' ? (
        <div className="flow-variables-out">
          <div className="flow-subhead">最终变量</div>
          <dl className="flow-variable-out-list">
            {Object.entries(run.variables).map(([name, value]) => (
              <div key={name} className="flow-variable-out">
                <dt>{name}</dt>
                <dd>{JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  )
}

/** 结构区的节点条目：动作类型、可读的请求与结果边去向。 */
export function Structure({ detail }: { detail: FlowDetail }) {
  return (
    <section className="flow-structure">
      <div className="flow-section-head">
        <span>结构</span>
        <span className="flow-count">
          {detail.nodeCount} 节点 · {detail.parallels.length} 并行
        </span>
      </div>
      <ol className="flow-nodes">
        {detail.nodes.map((node, index) => (
          <li key={node.ref} className="flow-node">
            <div className="flow-node-head">
              <span className="flow-node-index">{index + 1}</span>
              <span className="flow-node-name">{node.name}</span>
              <span className={`flow-chip kind-${node.kind}`}>{nodeKindLabel(node.kind)}</span>
            </div>
            <div className="flow-node-body">
              {node.kind === 'command' ? (
                <code className="flow-command">
                  {node.request?.command ?? ''} {(node.request?.args ?? []).join(' ')}
                  {node.request?.output === 'variables' ? ' → 变量' : ''}
                </code>
              ) : (
                <p className="flow-prompt">{node.prompt}</p>
              )}
              <ul className="flow-outcomes">
                {node.outcomes.map((outcome) => (
                  <li key={outcome.name} className="flow-outcome" title={outcome.description}>
                    {outcomeLabel(outcome)}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
