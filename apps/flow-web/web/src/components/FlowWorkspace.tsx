import { useMemo } from 'react'
import {
  flowAvailability,
  formatTime,
  missingVariables,
  statusLabel,
  statusTone,
} from '../lib/flow'
import { useFlowStore } from '../store'
import { RunDetail } from './RunDetail'
import { Structure } from './Structure'

/**
 * 工作区：一次运行的前半段是「选 Flow、填变量、启动」，
 * 后半段是运行清单与所选运行的过程记录。不含模块标题区。
 */
export function FlowWorkspace() {
  const {
    config,
    detail,
    flows,
    draft,
    executorId,
    setExecutor,
    setDraft,
    start,
    busy,
    error,
    clearError,
    runs,
    runId,
    run,
    selectRun,
    refreshRuns,
  } = useFlowStore()

  const availability = flowAvailability(detail)
  const missing = useMemo(
    () => (detail === undefined ? [] : missingVariables(detail, draft)),
    [detail, draft],
  )
  const flowNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const flow of flows) map.set(flow.id, flow.name)
    return map
  }, [flows])
  const canStart = availability === null && missing.length === 0 && busy === null
  // 运行进度：取最后一条带节点的事件，只用来在结构图上标注。
  const currentRef = run?.events
    .filter((event) => event.nodeRef !== undefined)
    .at(-1)?.nodeRef
  const startReason =
    availability ?? (missing.length > 0 ? `必填变量未填写：${missing.join('、')}` : null)

  return (
    <div className="flow-workspace">
      <header className="flow-header">
        <div className="flow-header-text">
          <h2 className="flow-title">{detail?.name ?? '未选择 Flow'}</h2>
          <p className="flow-description">{detail?.description ?? ''}</p>
          <code className="flow-path" title={detail?.path ?? ''}>
            {detail?.id ?? '-'}
            {detail === undefined ? '' : ` · ${detail.dir}`}
          </code>
        </div>
        <button
          type="button"
          className="flow-link"
          onClick={() => void refreshRuns()}
          title="重新读取运行清单"
        >
          刷新运行
        </button>
      </header>

      {error === null ? null : (
        <div className="flow-error-bar">
          <span>{error}</span>
          <button type="button" className="flow-link" onClick={clearError}>
            关闭
          </button>
        </div>
      )}

      {detail === undefined ? (
        <p className="flow-empty">
          从左边选择一个 Flow 包。工作区会显示它的结构、启动变量和运行记录。
        </p>
      ) : (
        <div className="flow-columns">
          <div className="flow-column">
            <section className="flow-config">
              <div className="flow-section-head">
                <span>启动变量</span>
                <span className="flow-count">
                  {detail.variables.length === 0 ? '无' : `${detail.variables.length} 项`}
                </span>
              </div>
              {detail.variables.length === 0 ? (
                <p className="flow-empty">这份 Flow 不需要启动变量。</p>
              ) : (
                <div className="flow-fields">
                  {detail.variables.map((variable) => (
                    <label key={variable.name} className="flow-field">
                      <span className="flow-field-name">
                        {variable.name}
                        {variable.required ? <span className="flow-required">*</span> : null}
                      </span>
                      <input
                        className="flow-input"
                        value={draft[variable.name] ?? ''}
                        placeholder={variable.required ? '必填' : '可选'}
                        onChange={(event) => setDraft(variable.name, event.target.value)}
                      />
                      <span className="flow-field-hint">
                        {variable.description}
                        {variable.default === undefined
                          ? ''
                          : ` · 默认 ${JSON.stringify(variable.default)}`}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flow-executor">
                <label className="flow-field">
                  <span className="flow-field-name">执行器</span>
                  <select
                    className="flow-input flow-select"
                    value={executorId}
                    disabled={busy !== null}
                    onChange={(event) => setExecutor(event.target.value)}
                  >
                    {(config?.executors ?? []).map((executor) => (
                      <option key={executor.id} value={executor.id}>
                        {executor.title}（{executor.id}）
                      </option>
                    ))}
                  </select>
                  <span className="flow-field-hint">
                    {config?.executors.find((executor) => executor.id === executorId)
                      ?.description ?? ''}
                  </span>
                </label>
              </div>
              <div className="flow-start">
                <button
                  type="button"
                  className="flow-button is-primary"
                  disabled={!canStart}
                  title={startReason ?? '按当前变量开始一次运行'}
                  onClick={() => void start()}
                >
                  {busy === 'start' ? '启动中' : '开始运行'}
                </button>
                <span className="flow-start-reason">
                  {startReason ?? '按当前变量开始一次运行'}
                </span>

              </div>
            </section>
            {detail.valid ? (
              <Structure
                detail={detail}
                {...(currentRef === undefined ? {} : { currentRef })}
              />
            ) : null}
          </div>

          <div className="flow-column">
            <section className="flow-runs">
              <div className="flow-section-head">
                <span>运行记录</span>
                <span className="flow-count">{runs.length} 次</span>
              </div>
              {runs.length === 0 ? (
                <p className="flow-empty">还没有运行记录。填好变量后点「开始运行」。</p>
              ) : (
                <ul className="flow-run-list">
                  {runs.map((item) => (
                    <li key={item.runId}>
                      <button
                        type="button"
                        className={`flow-run-item${item.runId === runId ? ' is-selected' : ''}`}
                        onClick={() => void selectRun(item.runId)}
                      >
                        <span className={`flow-chip tone-${statusTone(item.status)}`}>
                          {statusLabel(item.status)}
                        </span>
                        <span className="flow-run-flow">
                          {flowNames.get(item.flowId) ?? (item.flowId || '未命名')}
                        </span>
                        <span className="flow-run-steps">{item.stepCount} 步</span>
                        <span className="flow-run-time">{formatTime(item.startedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {run === undefined ? null : <RunDetail run={run} detail={detail} />}
          </div>
        </div>
      )}
    </div>
  )
}
