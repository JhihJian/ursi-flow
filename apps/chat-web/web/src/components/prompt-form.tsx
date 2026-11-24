import * as React from 'react'
import { RiArrowUpLine, RiStopFill } from '@remixicon/react'

import { type GatewayModel } from '@/lib/models'
import { ModelSelect } from '@/components/model-select'

export function PromptForm({
  models,
  model,
  onModelChange,
  isBusy,
  onSubmit,
  onStop,
}: {
  models: GatewayModel[]
  model: string
  onModelChange: (model: string) => void
  isBusy: boolean
  onSubmit: (text: string) => void
  onStop: () => void
}) {
  const [input, setInput] = React.useState('')

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault()
    const text = input.trim()
    if (!text || isBusy) return
    onSubmit(text)
    setInput('')
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        className="composer-input"
        placeholder="Send a message…"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            handleSubmit()
          }
        }}
      />
      <div className="composer-bar">
        <ModelSelect
          models={models}
          value={model}
          onValueChange={onModelChange}
        />
        {isBusy ? (
          <button
            type="button"
            className="composer-send"
            aria-label="Stop generating"
            onClick={onStop}
          >
            <RiStopFill />
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send"
            aria-label="Send message"
            disabled={!input.trim()}
          >
            <RiArrowUpLine />
          </button>
        )}
      </div>
    </form>
  )
}
