import * as React from 'react'

export function Message({
  align,
  children,
}: {
  align: 'start' | 'end'
  children: React.ReactNode
}) {
  return <div className={`message message-${align}`}>{children}</div>
}

export function MessageContent({ children }: { children: React.ReactNode }) {
  return <div className="message-content">{children}</div>
}

export function MessageFooter({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <div className={`message-footer ${className ?? ''}`}>{children}</div>
}

export function Bubble({
  align,
  variant = 'default',
  children,
}: {
  align: 'start' | 'end'
  variant?: 'default' | 'muted'
  children: React.ReactNode
}) {
  return (
    <div className={`bubble bubble-${align}${variant === 'muted' ? ' bubble-muted' : ''}`}>
      {children}
    </div>
  )
}

export function BubbleContent({ children }: { children: React.ReactNode }) {
  return <div className="bubble-content">{children}</div>
}
