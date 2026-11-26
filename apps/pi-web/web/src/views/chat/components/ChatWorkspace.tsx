import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatModelOption } from '../../config/api/client'
import { parsePiJsonl, TrajectoryViewer } from 'pi-agent-trajectory-viewer'
import { useChatController } from '../chat-context'

const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  error: '出错',
}

function refOf(model: ChatModelOption): string {
  return `${model.provider}/${model.id}`
}

/** 档位的展示名：供应商有真实值映射时一并给出。 */
function thinkingLabel(level: string, model: ChatModelOption | null): string {
  const mapped = model?.thinkingLevelMap?.[level]
  if (mapped && mapped !== level) return `${level} → ${mapped}`
  return level
}

/**
 * 对话工作区：已落盘部分交给轨迹组件库渲染（与会话模块同一份解析），
 * 流式中的文本、思考与正在跑的工具单独渲染在末尾，落盘后由权威 transcript 替换。
 */
export function ChatWorkspace() {
  const {
    active,
    options,
    optionsError,
    home,
    draft,
    setDraft,
    draftModel,
    draftThinkingLevel,
    activeModel,
    transcript,
    partial,
    thinking,
    streaming,
    pending,
    runningTools,
    retry,
    compacting,
    connectionLost,
    error,
    notice,
    clearNotice,
    uiRequests,
    answer,
    submit,
    abort,
    switchModel,
    setThinkingLevel,
    close,
    sending,
    startNewChat,
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
  }, [transcript, partial, thinking, runningTools.length])

  const busy = streaming || pending > 0
  const model = active ? activeModel : draftModel
  const levels = model?.thinkingLevels.length ? model.thinkingLevels : []
  const currentThinking = active ? (active.thinkingLevel ?? '') : draftThinkingLevel
  const uiRequest = uiRequests[0] ?? null

  async function send(mode?: 'steer' | 'followUp') {
    const content = text.trim()
    if (!content || sending) return
    setText('')
    const result = await submit(content, mode)
    if (!result.ok) {
      // 发不出去就把文本放回输入框，不静默丢弃。
      setText((current) => (current ? `${content}\n\n${current}` : content))
      inputRef.current?.focus()
    }
  }

  function stop() {
    void abort().then((recalled) => {
      if (!recalled) return
      setText((current) => (current ? `${recalled}\n\n${current}` : recalled))
      inputRef.current?.focus()
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(busy ? 'followUp' : undefined)
      return
    }
    if (event.key === 'Escape' && streaming) {
      event.preventDefault()
      stop()
    }
  }

  /** 换模型时把思考档位也落到新模型支持的值上。 */
  function changeModel(nextRef: string) {
    const next = options?.models.find((item) => refOf(item) === nextRef) ?? null
    if (!next) return
    const nextLevels = next.thinkingLevels
    const target =
      (currentThinking && nextLevels.includes(currentThinking) ? currentThinking : '') ||
      options?.thinkingLevelPins[nextRef] ||
      options?.defaultThinkingLevel ||
      nextLevels[0] ||
      ''
    if (active) {
      void switchModel(next.provider, next.id, target && nextLevels.includes(target) ? target : undefined)
      return
    }
    setDraft({ model: nextRef, thinkingLevel: target })
  }

  function changeThinking(level: string) {
    if (active) {
      void setThinkingLevel(level)
      return
    }
    setDraft({ thinkingLevel: level })
  }

  const modelValue = model ? refOf(model) : ''
  const modelChoices = options?.models ?? []

  return (
    <div className="pichat pichat-workspace">
      <header className="pichat-bar">
        <span className="pichat-bar-title">
          {active ? (active.name ?? active.sessionId.slice(0, 12)) : '新对话'}
        </span>
        <span className="pichat-bar-meta" title={active ? active.home : home}>
          {active ? active.cwd : home || '未选 pi home'}
        </span>
        {active ? (
          <span className={`pichat-bar-meta pichat-state is-${active.state}`}>
            {STATUS_TEXT[active.state] ?? active.state}
          </span>
        ) : null}
        <span className="pichat-bar-actions">
          {streaming ? (
            <button type="button" className="pichat-button is-sm" onClick={stop}>
              停止
            </button>
          ) : null}
          {active ? (
            <>
              <button type="button" className="pichat-button is-sm" onClick={startNewChat}>
                新对话
              </button>
              <button type="button" className="pichat-button is-sm" onClick={() => void close()}>
                结束
              </button>
            </>
          ) : null}
        </span>
      </header>

      {error ? <div className="pichat-banner is-error">{error}</div> : null}
      {connectionLost ? (
        <div className="pichat-banner">
          <span>事件流断开，正在重连；重连后会补回这段输出。</span>
        </div>
      ) : null}
      {retry ? (
        <div className="pichat-banner">
          <span>
            正在重试（{retry.attempt}/{retry.maxAttempts}）：{retry.message}
          </span>
        </div>
      ) : null}
      {compacting ? <div className="pichat-banner">正在压缩上下文…</div> : null}
      {optionsError ? <div className="pichat-banner is-error">{optionsError}</div> : null}
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
            <p>{active ? '发一条消息开始这段对话。' : '选好模型，发第一条消息就建立对话。'}</p>
            <p className="pichat-hint">
              {active
                ? `模型、工具与凭据都来自 ${active.home}；工作目录 ${active.cwd}。`
                : draft.cwd
                  ? `工作目录 ${draft.cwd}；模型与思考级别在下面选。`
                  : '工作目录留空时用服务端默认目录；模型与思考级别在下面选。'}
            </p>
          </div>
        )}

        {thinking ? (
          <div className="pichat-streaming is-thinking">
            <div className="pichat-streaming-head">
              <span className="pichat-streaming-tag">思考</span>
            </div>
            <pre className="pichat-streaming-body">{thinking}</pre>
          </div>
        ) : null}

        {partial ? (
          <div className="pichat-streaming">
            <div className="pichat-streaming-head">
              <span className="pichat-streaming-tag">正在输出</span>
              <span>{active?.model ?? '默认模型'}</span>
            </div>
            <pre className="pichat-streaming-body">{partial}</pre>
          </div>
        ) : null}

        {runningTools.length > 0 ? (
          <ul className="pichat-tools">
            {runningTools.map((tool) => (
              <li key={tool.id} className="pichat-tool">
                <span className="pichat-tool-name">{tool.name}</span>
                <span className="pichat-hint">正在执行…</span>
              </li>
            ))}
          </ul>
        ) : null}

        {pending > 0 ? <div className="pichat-pending">排队中：{pending} 条</div> : null}
      </div>

      {uiRequest ? (
        <div className="pichat-ui-request">
          <div className="pichat-ui-request-head">
            {uiRequest.kind === 'confirm' ? '需要确认' : uiRequest.kind === 'select' ? '请选择' : '请填写'}
            <span className="pichat-label">{uiRequest.title}</span>
            {uiRequests.length > 1 ? (
              <span className="pichat-count">还有 {uiRequests.length - 1} 个</span>
            ) : null}
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
            busy
              ? '运行中：Enter 排队，Shift+Enter 换行，Esc 停止'
              : active
                ? '输入消息，Enter 发送，Shift+Enter 换行'
                : '发出第一条消息即建立对话，Enter 发送'
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
        />

        <div className="pichat-composer-bar">
          <label className="pichat-bar-field">
            <span className="pichat-label">模型</span>
            <select
              className="pichat-select is-inline"
              value={modelValue}
              onChange={(event) => changeModel(event.target.value)}
              disabled={streaming}
              title={model ? `${refOf(model)}${model.name !== model.id ? ` · ${model.name}` : ''}` : ''}
            >
              {modelChoices.length === 0 ? (
                <option value={modelValue}>{modelValue || '该 home 还没有模型目录'}</option>
              ) : (
                <>
                  {!modelValue ? <option value="">未指定模型</option> : null}
                  {modelValue && !modelChoices.some((item) => refOf(item) === modelValue) ? (
                    <option value={modelValue}>{modelValue}（不在候选范围）</option>
                  ) : null}
                </>
              )}
              {groupByProvider(modelChoices).map((group) => (
                <optgroup key={group.provider} label={group.providerName}>
                  {group.models.map((item) => (
                    <option key={refOf(item)} value={refOf(item)}>
                      {item.name !== item.id ? `${item.name} · ${item.id}` : item.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label className="pichat-bar-field">
            <span className="pichat-label">思考</span>
            <select
              className="pichat-select is-inline"
              value={currentThinking}
              onChange={(event) => changeThinking(event.target.value)}
              disabled={levels.length === 0}
            >
              {levels.length === 0 ? <option value={currentThinking}>{currentThinking || '该模型不支持思考'}</option> : null}
              {levels.map((level) => (
                <option key={level} value={level}>
                  {thinkingLabel(level, model)}
                </option>
              ))}
            </select>
          </label>

          <div className="pichat-composer-actions">
            {busy ? (
              <>
                <button type="button" className="pichat-button is-sm" onClick={() => void send('followUp')}>
                  排队发送
                </button>
                <button type="button" className="pichat-button is-sm" onClick={() => void send('steer')}>
                  立即插话
                </button>
              </>
            ) : (
              <button
                type="button"
                className="pichat-button is-sm is-primary"
                disabled={sending || !text.trim()}
                onClick={() => void send()}
              >
                {active ? '发送' : '建立对话并发送'}
              </button>
            )}
          </div>
        </div>
        {options?.isScoped ? (
          <p className="pichat-hint">候选模型按该 home 的 enabledModels 限定。</p>
        ) : null}
      </div>
    </div>
  )
}

function groupByProvider(models: ChatModelOption[]): Array<{ provider: string; providerName: string; models: ChatModelOption[] }> {
  const groups: Array<{ provider: string; providerName: string; models: ChatModelOption[] }> = []
  for (const model of models) {
    const existing = groups.find((group) => group.provider === model.provider)
    if (existing) existing.models.push(model)
    else groups.push({ provider: model.provider, providerName: model.providerName, models: [model] })
  }
  return groups
}
