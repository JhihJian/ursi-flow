import { type AskUserToolPart } from '@/api/types'
import { StatusIcon } from '@/components/status-icon'
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export function AskUserPart({ part }: { part: AskUserToolPart }) {
  if (part.state !== 'output-available') {
    return null
  }

  const count = part.output.length

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <StatusIcon />
          </TraceIcon>
          <TraceTitle>
            Asked {count} {count === 1 ? 'question' : 'questions'}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <dl className="trace-qa">
          {part.output.map((entry) => (
            <div key={entry.question}>
              <dt>{entry.question}</dt>
              <dd>{entry.answer}</dd>
            </div>
          ))}
        </dl>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
