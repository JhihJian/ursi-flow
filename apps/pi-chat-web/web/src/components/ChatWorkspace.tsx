import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import { useChatController } from '../chat-context'

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  error: '出错',
}

/**
 * 对话工作区：已落盘部分交给轨迹组件库渲染（与会话模块同一份解析），
 * 流式中的那一段单独渲染在末尾，落盘后由权威文本替换。
 */
export function ChatWorkspace() {
  const {
    active,
    transcript,
    partial,
    streaming,
    pending,
    error,
    notice,
    clearNotice,
    uiRequests,
    answer,
    send,
    abort,
    switchModel,
    close,
    options,
  } = useChatController()
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const parsed = useMemo(() => {
    if (!transcript.trim()) return null
    try {
      return { ok: true as const, value: parsePiJsonl(transcript) }
    } catch (failure) {
      return { ok: false as const, message: failure instanceof Error ? failure.message : String(failure) }
    }
  }, [transcript])

  // 新内容到达时贴住底部；用户往上翻时不打扰。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 240
    if (nearBottom) body.scrollTop = body.scrollHeight
  }, [transcript, partial])

  if (!active) {
    return (
      <div className="pichat pichat-workspace">
        <div className="pichat-center">
          <p>在左侧选择一份 pi home 并新建对话。</p>
          <p className="pichat-hint">
            对话用的是该 home 的模型、凭据、skills 与 agents；会话文件写进它的 sessions/，
            聊完能在会话模块里看到完整轨迹。
          </p>
        </div>
      </div>
    )
  }

  const modelValue = active.model ?? ''
  const [modelProvider, modelId] = modelValue.split('/')
  const uiRequest = uiRequests[0] ?? null

  function submit(mode?: 'steer' | 'followUp') {
    const content = text.trim()
    if (!content) return
    setText('')
    void send(content, mode)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(streaming || pending > 0 ? 'followUp' : undefined)
    }
    if (event.key === 'Escape' && streaming) {
      event.preventDefault()
      void abort()
    }
  }

  return (
    <div className="pichat pichat-workspace">
      <header className="pichat-bar">
        <span className="pichat-bar-title">{active.name ?? active.sessionId.slice(0, 12)}</span>
        <span className="pichat-bar-meta" title={active.home}>
          {active.home}
        </span>
        <label className="pichat-bar-field">
          <span className="pichat-label">模型</span>
          <select
            className="pichat-select is-inline"
            value={modelValue}
            onChange={(event) => {
              const [provider, id] = event.target.value.split('/')
              if (provider && id) void switchModel(provider, id)
            }}
            disabled={streaming}
          >
            {modelValue ? null : <option value="">默认模型</option>}
            {(options?.models ?? []).map((model) => {
              const value = `${model.provider}/${model.id}`
              return (
                <option key={value} value={value}>
                  {value}
                  {model.enabled ? '' : '（未启用）'}
                </option>
              )
            })}
          </select>
        </label>
        <span className={`pichat-bar-meta pichat-state is-${active.state}`}>
          {STATUS_TEXT[active.state] ?? active.state}
        </span>
        {active.thinkingLevel ? (
          <span className="pichat-bar-meta">思考 {active.thinkingLevel}</span>
        ) : null}
        <span className="pichat-bar-actions">
          {streaming ? (
            <button type="button" className="pichat-button is-sm" onClick={() => void abort()}>
              停止
            </button>
          ) : null}
          <button type="button" className="pichat-button is-sm" onClick={() => void close()}>
            结束
          </button>
        </span>
      </header>

      {error ? <div className="pichat-banner is-error">{error}</div> : null}
      {notice ? (
        <div className="pichat-banner">
          <span>{notice.message}</span>
          <button type="button" className="pichat-link" onClick={clearNotice}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="pichat-thread" ref={bodyRef}>
        {parsed?.ok ? (
          <TrajectoryViewer
            turns={parsed.value.turns}
            rows={parsed.value.rows}
            diagnostics={parsed.value.diagnostics}
            sessionRevision={0}
          />
        ) : parsed && !parsed.ok ? (
          <div className="pichat-center">
            <p className="pichat-error">解析会话内容失败：{parsed.message}</p>
          </div>
        ) : (
          <div className="pichat-center">
            <p>发一条消息开始这段对话。</p>
            <p className="pichat-hint">模型、工具与凭据都来自 {active.home}。</p>
          </div>
        )}

        {partial ? (
          <div className="pichat-streaming">
            <div className="pichat-streaming-head">
              <span className="pichat-streaming-tag">正在输出</span>
              <span>{active.model ?? '默认模型'}</span>
            </div>
            <pre className="pichat-streaming-body">{partial}</pre>
          </div>
        ) : null}
        {pending > 0 ? <div className="pichat-pending">排队中：{pending} 条</div> : null}
      </div>

      {uiRequest ? (
        <div className="pichat-ui-request">
          <div className="pichat-ui-request-head">
            {uiRequest.kind === 'confirm' ? '需要确认' : uiRequest.kind === 'select' ? '请选择' : '请填写'}
            <span className="pichat-label">{uiRequest.title}</span>
          </div>
          {uiRequest.message ? <p className="pichat-ui-request-msg">{uiRequest.message}</p> : null}
          {uiRequest.kind === 'confirm' ? (
            <div className="pichat-ui-request-actions">
              <button
                type="button"
                className="pichat-button is-sm is-primary"
                onClick={() => void answer(uiRequest.requestId, true)}
              >
                同意
              </button>
              <button
                type="button"
                className="pichat-button is-sm"
                onClick={() => void answer(uiRequest.requestId, false)}
              >
                拒绝
              </button>
            </div>
          ) : null}
          {uiRequest.kind === 'select' ? (
            <div className="pichat-ui-request-actions">
              {(uiRequest.options ?? []).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="pichat-button is-sm"
                  onClick={() => void answer(uiRequest.requestId, option)}
                >
                  {option}
                </button>
              ))}
              <button
                type="button"
                className="pichat-link"
                onClick={() => void answer(uiRequest.requestId, undefined)}
              >
                取消
              </button>
            </div>
          ) : null}
          {uiRequest.kind === 'input' ? (
            <form
              className="pichat-ui-request-actions"
              onSubmit={(event) => {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('value')
                void answer(uiRequest.requestId, typeof value === 'string' ? value : '')
              }}
            >
              <input
                name="value"
                className="pichat-input"
                placeholder={uiRequest.placeholder ?? ''}
                autoFocus
              />
              <button type="submit" className="pichat-button is-sm is-primary">
                提交
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <div className="pichat-composer">
        <textarea
          ref={inputRef}
          className="pichat-textarea"
          value={text}
          placeholder={
            streaming || pending > 0
              ? '运行中：Enter 排队，Shift+Enter 换行，Esc 停止'
              : 'Enter 发送，Shift+Enter 换行'
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
        />
        <div className="pichat-composer-bar">
          {modelProvider && modelId ? (
            <span className="pichat-hint">
              {modelProvider}/{modelId}
            </span>
          ) : null}
          <div className="pichat-composer-actions">
            {streaming || pending > 0 ? (
              <>
                <button type="button" className="pichat-button is-sm" onClick={() => submit('followUp')}>
                  排队发送
                </button>
                <button type="button" className="pichat-button is-sm" onClick={() => submit('steer')}>
                  立即插话
                </button>
              </>
            ) : (
              <button type="button" className="pichat-button is-sm is-primary" onClick={() => submit()}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
