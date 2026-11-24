import * as React from 'react'

export function Alert({
  variant = 'default',
  children,
}: {
  variant?: 'default' | 'destructive'
  children: React.ReactNode
}) {
  return (
    <div className={`alert${variant === 'destructive' ? ' alert-destructive' : ''}`}>
      {children}
    </div>
  )
}

export function AlertTitle({ children }: { children: React.ReactNode }) {
  return <div className="alert-title">{children}</div>
}

export function AlertDescription({ children }: { children: React.ReactNode }) {
  return <div className="alert-desc">{children}</div>
}
