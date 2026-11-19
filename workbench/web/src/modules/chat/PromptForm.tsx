import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/textarea'

export interface PromptFormProps {
  disabled: boolean
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
}

/** 输入区：Enter 发送、Shift+Enter 换行，流式中改为停止按钮。 */
export function PromptForm({ disabled, streaming, onSend, onStop }: PromptFormProps) {
  const [input, setInput] = useState('')

  function submit() {
    const value = input.trim()
    if (!value || streaming || disabled) return
    setInput('')
    onSend(value)
  }

  return (
    <form
      className="flex items-end gap-2 border-t border-line p-3"
      onSubmit={(event) => { event.preventDefault(); submit() }}
    >
      <Textarea
        aria-label="输入消息"
        placeholder="就当前工作流与运行记录提问，Enter 发送，Shift+Enter 换行"
        rows={1}
        className="max-h-40 min-h-[2.75rem] resize-none py-2.5"
        disabled={disabled}
        value={input}
        onChange={(event) => { setInput(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      {streaming ? (
        <Button icon="chat-stop" onClick={onStop}>停止</Button>
      ) : (
        <Button type="submit" variant="primary" icon="chat-send" disabled={disabled || !input.trim()}>发送</Button>
      )}
    </form>
  )
}
