import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { type TextMessagePart } from '@/api/types'
import { MarkdownPre } from '@/components/markdown-code'

export function TextPart({ part }: { part: TextMessagePart }) {
  return (
    <div className="typeset">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: MarkdownPre }}
      >
        {part.text}
      </ReactMarkdown>
    </div>
  )
}
