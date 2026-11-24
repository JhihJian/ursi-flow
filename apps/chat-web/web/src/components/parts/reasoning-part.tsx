import * as React from 'react'

import { type ReasoningMessagePart } from '@/api/types'
import { StatusIcon } from '@/components/status-icon'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export function ReasoningPart({
  part,
  isStreaming,
  duration,
}: {
  part: ReasoningMessagePart
  isStreaming: boolean
  duration?: number
}) {
  const [open, setOpen] = React.useState<boolean>()
  const running = isStreaming && part.state === 'streaming'
  const status = running ? 'running' : undefined

  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <StatusIcon status={status} />
      </TraceIcon>
      <TraceTitle>{running ? 'Thinking' : 'Thought'}</TraceTitle>
      {!running && duration !== undefined && (
        <TraceDescription>
          {Math.max(1, Math.round(duration / 1000))}s
        </TraceDescription>
      )}
    </TraceLine>
  )

  if (!part.text) {
    return line
  }

  // 思考时展开，结束后收起，除非用户手动切换过。
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="trace-reasoning">
        {part.text}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
