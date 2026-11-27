import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatModelOption } from './views/config/api/client'
import { useChatController } from './views/chat/chat-context'
import { usePiNav } from './pi-nav'

export interface ComposerHandle {
  /** 发不出去时把文本放回输入框。 */
  putBack: (text: string) => void
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

export interface ComposerProps {
  /** 会话页指向的会话 id：空会话页时为 null，此时目录来自侧栏点选。 */
  sessionId: string | null
}

/**
 * 输入区：正文、模型、思考级别。目录不在这里：它来自侧栏点选，显示在标题栏。
 * 全应用只有这一个输入框：空会话页发首条是建立，已打开的会话发消息是续聊，都走 submit。
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ sessionId }, ref) {
  const {
    active,
    options,
    optionsError,
    // draft 不在这里读：模型与档位经 draftModel / draftThinkingLevel 派生。
    setDraft,
    draftModel,
    draftThinkingLevel,
    activeModel,
    streaming,
    pending,
    submit,
    abort,
    switchModel,
    setThinkingLevel,
    sending,
  } = useChatController()
  const { cwd } = usePiNav()

  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  /** 发不出去时把文本放回输入框顶部，不静默丢弃。 */
  function putBack(content: string) {
    setText((current) => (current ? `${content}\n\n${current}` : content))
    inputRef.current?.focus()
  }

  useImperativeHandle(ref, () => ({ putBack }), [])

  const busy = streaming || pending > 0
  const model = active ? activeModel : draftModel
  const levels = model?.thinkingLevels.length ? model.thinkingLevels : []
  const currentThinking = active ? (active.thinkingLevel ?? '') : draftThinkingLevel

  async function send(sendMode?: 'steer' | 'followUp') {
    const content = text.trim()
    if (!content || sending) return
    setText('')
    const result = await submit(content, sendMode)
    if (!result.ok) putBack(content)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(busy ? 'followUp' : undefined)
      return
    }
    if (event.key === 'Escape' && streaming) {
      event.preventDefault()
      void abort().then((recalled) => {
        if (recalled) putBack(recalled)
      })
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
  // 空会话页要有目录才能建会话；已打开的会话目录在会话头里。
  const canSend = !sending && text.trim().length > 0 && (sessionId !== null || cwd !== null)

  return (
    <>
      {optionsError ? <div className="pichat-banner is-error">{optionsError}</div> : null}
      <div className="pichat-composer">
        <textarea
          ref={inputRef}
          className="pichat-textarea"
          value={text}
          placeholder={
            busy
              ? '运行中：Enter 排队，Shift+Enter 换行，Esc 停止'
              : sessionId !== null
                ? '输入消息，Enter 发送，Shift+Enter 换行'
                : cwd
                  ? '发出第一条消息即建立对话，Enter 发送'
                  : '先在左侧点选一个目录'
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
                disabled={!canSend}
                onClick={() => void send()}
              >
                {sessionId === null ? '建立对话并发送' : '发送'}
              </button>
            )}
          </div>
        </div>
        {options?.isScoped ? <p className="pichat-hint">候选模型按该 home 的 enabledModels 限定。</p> : null}
      </div>
    </>
  )
})

function groupByProvider(models: ChatModelOption[]): Array<{ provider: string; providerName: string; models: ChatModelOption[] }> {
  const groups: Array<{ provider: string; providerName: string; models: ChatModelOption[] }> = []
  for (const model of models) {
    const existing = groups.find((group) => group.provider === model.provider)
    if (existing) existing.models.push(model)
    else groups.push({ provider: model.provider, providerName: model.providerName, models: [model] })
  }
  return groups
}
