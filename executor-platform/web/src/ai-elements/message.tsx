// Adapted from Vercel AI Elements (Apache-2.0). See PROVENANCE.md.
import { memo, type ComponentProps } from 'react'
import Markdown from 'react-markdown'
import { cn } from '@/shared/lib/utils'

export type MessageProps = ComponentProps<'div'> & {
  from: 'user' | 'assistant' | 'system'
}

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        'group flex w-full min-w-0 max-w-[95%] flex-col gap-2',
        from === 'user' ? 'is-user ml-auto' : 'is-assistant',
        className,
      )}
      {...props}
    />
  )
}

export type MessageContentProps = ComponentProps<'div'>

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        'flex w-fit min-w-0 max-w-full flex-col gap-2 text-sm text-txt [overflow-wrap:anywhere]',
        'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3',
        className,
      )}
      {...props}
    />
  )
}

export type MessageResponseProps = Omit<ComponentProps<'div'>, 'children' | 'dangerouslySetInnerHTML'> & {
  children?: string
}

const markdownElements = [
  'p', 'br', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'code', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]

export const MessageResponse = memo(function MessageResponse({ className, children, ...props }: MessageResponseProps) {
  return (
    <div
      className={cn(
        'min-w-0 max-w-full [overflow-wrap:anywhere] [&>*+*]:mt-3',
        '[&_h1]:text-base [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
        '[&_ol]:list-decimal [&_ul]:list-disc [&_:is(ol,ul)]:pl-5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-txt2',
        '[&_code]:rounded-sm [&_code]:bg-elevated [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs',
        '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-elevated [&_pre]:p-3 [&_pre_code]:p-0',
        '[&_hr]:border-line',
        className,
      )}
      {...props}
    >
      <Markdown allowedElements={markdownElements} skipHtml unwrapDisallowed>
        {children}
      </Markdown>
    </div>
  )
})
