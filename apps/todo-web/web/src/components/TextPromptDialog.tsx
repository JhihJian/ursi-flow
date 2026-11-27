import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTodoStore, type TextPromptState } from '@/store/todo-store'

/**
 * 需要补填一段文字时（完成结果、阻塞原因）的内嵌输入框，
 * 替代浏览器原生 prompt，样式跟随看板的灰阶风格。
 */
export function TextPromptDialog() {
  const prompt = useTodoStore((state) => state.textPrompt)
  const settle = useTodoStore((state) => state.settleTextPrompt)
  if (!prompt) return null
  return (
    <TextPrompt
      key={prompt.id}
      prompt={prompt}
      onClose={() => settle(null)}
      onSubmit={(value) => settle(value)}
    />
  )
}

function TextPrompt({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: TextPromptState
  onClose: () => void
  onSubmit: (value: string) => void
}) {
  const { options } = prompt
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc 只关闭这个输入框，不触发外层的关闭详情。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const submit = () => {
    const text = value.trim()
    if (!text && options.requiredMessage) {
      setError(options.requiredMessage)
      inputRef.current?.focus()
      return
    }
    onSubmit(text)
  }

  return createPortal(
    <div
      className="todo-prompt-backdrop"
      onPointerDown={(event) => {
        // 点面板外空白关闭，和右键菜单的关闭习惯一致。
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="todo-prompt-panel" role="dialog" aria-modal="true" aria-label={options.title}>
        <h2 className="todo-prompt-title">{options.title}</h2>
        <label className="todo-prompt-field">
          <span className="todo-prompt-label">{options.label}</span>
          <textarea
            ref={inputRef}
            className={options.multiline ? 'todo-prompt-input' : 'todo-prompt-input is-single'}
            rows={options.multiline ? 5 : 1}
            placeholder={options.placeholder}
            value={value}
            aria-label={options.label}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // 多行输入里的回车是换行，Ctrl+Enter 才提交。
              if (options.multiline && !(event.ctrlKey || event.metaKey)) return
              event.preventDefault()
              submit()
            }}
          />
        </label>
        <div className="todo-prompt-footer">
          {error ? <span className="todo-prompt-error">{error}</span> : null}
          <div className="todo-prompt-actions">
            <button type="button" className="btn" onClick={onClose}>
              cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit}>
              {options.confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
