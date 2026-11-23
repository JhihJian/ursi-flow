// Adapted from Vercel AI Elements (Apache-2.0). See PROVENANCE.md.
import { useRef, type ComponentProps, type KeyboardEventHandler } from 'react'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export type PromptInputProps = ComponentProps<'form'>

export function PromptInput({ className, ...props }: PromptInputProps) {
  return (
    <form
      className={cn('w-full rounded-lg border border-line bg-surface focus-within:border-accent', className)}
      {...props}
    />
  )
}

export type PromptInputTextareaProps = ComponentProps<'textarea'>

export function PromptInputTextarea({
  className,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  name = 'message',
  rows = 2,
  ...props
}: PromptInputTextareaProps) {
  const isComposing = useRef(false)
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || isComposing.current || event.nativeEvent.isComposing) {
      return
    }
    const form = event.currentTarget.form
    if (!form) return

    event.preventDefault()
    if (event.repeat) return

    // Use the form's first submit control, including controls associated by the form attribute.
    const submitter = Array.from(form.elements).find(
      (element): element is HTMLButtonElement | HTMLInputElement =>
        (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit',
    )
    if (submitter && !submitter.matches(':disabled')) form.requestSubmit(submitter)
  }

  return (
    <textarea
      className={cn(
        'block min-h-16 w-full resize-none rounded-t-lg bg-transparent px-3 py-2 text-sm text-txt outline-none placeholder:text-txt3 disabled:opacity-50',
        'supports-[field-sizing:content]:max-h-48 supports-[field-sizing:content]:[field-sizing:content]',
        className,
      )}
      name={name}
      rows={rows}
      onCompositionEnd={(event) => {
        isComposing.current = false
        onCompositionEnd?.(event)
      }}
      onCompositionStart={(event) => {
        isComposing.current = true
        onCompositionStart?.(event)
      }}
      onKeyDown={handleKeyDown}
      {...props}
    />
  )
}

export type PromptInputFooterProps = ComponentProps<'div'>

export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return <div className={cn('flex items-center justify-between gap-1 px-2 pb-2', className)} {...props} />
}

export type PromptInputSubmitProps = Omit<ComponentProps<typeof Button>, 'asChild'>

export function PromptInputSubmit({
  className,
  children,
  type = 'submit',
  icon = children == null && type === 'submit' ? 'send' : undefined,
  size = 'icon',
  variant = 'primary',
  ...props
}: PromptInputSubmitProps) {
  return (
    <Button
      aria-label={children == null && type === 'submit' ? '发送' : undefined}
      className={cn('ml-auto shrink-0', className)}
      icon={icon}
      size={size}
      type={type}
      variant={variant}
      {...props}
    >
      {children}
    </Button>
  )
}
