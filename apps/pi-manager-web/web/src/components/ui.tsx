import type { ReactNode } from 'react'

/** 列表三态与区块通用小件。 */

export function Loading({ label = '读取中' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      <span>{label}…</span>
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner" role="alert">{message}</div>
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {hint ? <div className="mono-dim">{hint}</div> : null}
    </div>
  )
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok'
  children: ReactNode
}) {
  return <div className={tone === 'info' ? 'notice' : `notice ${tone}`}>{children}</div>
}

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <h2 className="settings-section-title">{title}</h2>
        {description ? <p className="settings-section-description">{description}</p> : null}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Switch({
  pressed,
  onChange,
  label,
  disabled,
}: {
  pressed: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="switch"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onChange(!pressed)}
    >
      <span className="switch-track" aria-hidden />
      <span className="switch-label">{label}</span>
    </button>
  )
}

export function Badge({
  tone,
  children,
}: {
  tone?: 'ok' | 'warn' | 'danger' | 'accent'
  children: ReactNode
}) {
  return <span className={tone ? `badge ${tone}` : 'badge'}>{children}</span>
}
