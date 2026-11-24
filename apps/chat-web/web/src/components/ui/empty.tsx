import * as React from 'react'

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

export function EmptyHeader({ children }: { children: React.ReactNode }) {
  return <div className="empty-header">{children}</div>
}

export function EmptyTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="empty-title">{children}</h1>
}

export function EmptyDescription({ children }: { children: React.ReactNode }) {
  return <p className="empty-desc">{children}</p>
}

export function EmptyContent({ children }: { children: React.ReactNode }) {
  return <div className="empty-content">{children}</div>
}
