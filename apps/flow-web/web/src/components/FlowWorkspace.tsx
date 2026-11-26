import { useMemo } from 'react'
import {
  currentNodeOf,
  flowAvailability,
  formatTime,
  missingVariables,
  runVariableSummary,
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
    flowId,
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
  const canStart = availability === null && missing.length === 0 && busy === null
  // 运行记录只看当前 Flow：Flow 名在小标题已经出现过，列表里不再重复。
  const flowRuns = runs.filter((item) => item.flowId === flowId)
  const executorTitle = (id: string) =>
    config?.executors.find((executor) => executor.id === id)?.title ?? (id || '未知执行器')
  const variableNames = detail?.variables.map((variable) => variable.name) ?? []
  // 运行进度：只标注还在推进或等待确认的运行，已结束的运行没有「当前节点」。
  const currentRef = run === undefined ? undefined : currentNodeOf(run)
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
          <div className="flow-column flow-column-config">
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
          </div>

          <div className="flow-column flow-column-structure">
            {detail.valid ? (
              <Structure
                detail={detail}
                {...(currentRef === undefined ? {} : { currentRef })}
              />
            ) : (
              <p className="flow-empty">这份 Flow 还没解析成功，先修正 FLOW.md。</p>
            )}
          </div>

          <div className="flow-column flow-column-runs">
            <section className="flow-runs">
              <div className="flow-section-head">
                <span>运行记录</span>
                <span className="flow-count">{flowRuns.length} 次</span>
              </div>
              {flowRuns.length === 0 ? (
                <p className="flow-empty">这个 Flow 还没有运行记录。填好变量后点「开始运行」。</p>
              ) : (
                <ul className="flow-run-list">
                  {flowRuns.map((item) => (
                    <li key={item.runId}>
                      <button
                        type="button"
                        className={`flow-run-item${item.runId === runId ? ' is-selected' : ''}`}
                        onClick={() => void selectRun(item.runId)}
                      >
                        <span className="flow-run-item-head">
                          <span className={`flow-chip tone-${statusTone(item.status)}`}>
                            {statusLabel(item.status)}
                          </span>
                          <span className="flow-run-time">{formatTime(item.startedAt)}</span>
                        </span>
                        <span
                          className="flow-run-vars"
                          title={JSON.stringify(item.variables)}
                        >
                          {runVariableSummary(item.variables, variableNames)}
                        </span>
                        <span className="flow-run-foot">
                          {executorTitle(item.executor)} · {item.stepCount} 步
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {run === undefined ? (
              <p className="flow-empty flow-run-placeholder">
                点一条运行记录，在这里看状态、过程事件和最终变量。
              </p>
            ) : (
              <RunDetail run={run} detail={detail} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
