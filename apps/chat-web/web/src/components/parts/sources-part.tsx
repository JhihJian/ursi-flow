import { RiArrowRightUpLine, RiGlobalLine } from '@remixicon/react'

import { type ChatMessagePart, type SourceUrlPart } from '@/api/types'
import { safeHttpUrl } from '@/lib/utils'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'

export function SourcesPart({ parts }: { parts: ChatMessagePart[] }) {
  const sources = getUniqueSources(parts)

  if (sources.length === 0) {
    return null
  }

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <RiGlobalLine />
            </TraceIcon>
            <TraceTitle>
              Used {sources.length}{' '}
              {sources.length === 1 ? 'source' : 'sources'}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {sources.map((source) => (
              <a
                key={source.url}
                className="trace-source-link"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                <TraceLine>
                  <TraceIcon>
                    <RiGlobalLine />
                  </TraceIcon>
                  <TraceTitle>
                    {source.title || getHostname(source.url)}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </TraceTitle>
                  <TraceIcon>
                    <RiArrowRightUpLine />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function getUniqueSources(parts: ChatMessagePart[]) {
  return parts
    .filter((part): part is SourceUrlPart => part.type === 'source-url')
    .filter((source) => safeHttpUrl(source.url))
    .filter(
      (source, index, all) =>
        all.findIndex((other) => other.url === source.url) === index,
    )
}

function getHostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
