import * as React from 'react'
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react'

export function CodeBlock({
  size,
  variant,
  className,
  children,
}: {
  size?: 'sm'
  variant?: 'default' | 'destructive'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={[
        'code-block',
        size === 'sm' ? 'code-block-sm' : '',
        variant === 'destructive' ? 'code-block-destructive' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

export function CodeBlockHeader({ children }: { children: React.ReactNode }) {
  return <div className="code-block-header">{children}</div>
}

export function CodeBlockTitle({ children }: { children: React.ReactNode }) {
  return <span className="code-block-title">{children}</span>
}

export function CodeBlockActions({ children }: { children: React.ReactNode }) {
  return <div className="code-block-actions">{children}</div>
}

export function CodeBlockCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])

  return (
    <button
      type="button"
      className="code-block-copy"
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => {})
      }}
    >
      {copied ? <RiCheckLine /> : <RiFileCopyLine />}
    </button>
  )
}

export function CodeBlockContent({
  wrap,
  className,
  children,
}: {
  wrap?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <pre
      className={[
        'code-block-content',
        wrap ? 'code-block-wrap' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </pre>
  )
}

export function CodeBlockLine({ children }: { children: React.ReactNode }) {
  return <span className="code-block-line">{children}</span>
}
