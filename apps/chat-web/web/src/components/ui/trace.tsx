import * as React from 'react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible'

export function Trace({ children }: { children: React.ReactNode }) {
  return <div className="trace">{children}</div>
}

export function TraceLine({
  status,
  children,
}: {
  status?: 'running' | 'error'
  children: React.ReactNode
}) {
  return (
    <div className={`trace-line${status ? ` trace-line-${status}` : ''}`}>
      {children}
    </div>
  )
}

export function TraceIcon({ children }: { children: React.ReactNode }) {
  return <span className="trace-icon">{children}</span>
}

export function TraceTitle({ children }: { children: React.ReactNode }) {
  return <span className="trace-title">{children}</span>
}

export function TraceDescription({ children }: { children: React.ReactNode }) {
  return <span className="trace-desc">{children}</span>
}

export function TraceCollapsible({
  open,
  onOpenChange,
  className,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={`trace-collapsible ${className ?? ''}`}
    >
      {children}
    </Collapsible>
  )
}

export function TraceCollapsibleTrigger({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <CollapsibleTrigger className="trace-collapsible-trigger">
      {children}
    </CollapsibleTrigger>
  )
}

export function TraceCollapsibleContent({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <CollapsibleContent
      className={`trace-collapsible-content ${className ?? ''}`}
    >
      {children}
    </CollapsibleContent>
  )
}
