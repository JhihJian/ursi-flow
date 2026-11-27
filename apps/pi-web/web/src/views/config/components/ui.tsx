import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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

interface ConfirmRequest {
  title: string
  /** 补充说明行；危险后果、不会自动删除的文件等写在这里。 */
  body?: string
  confirmLabel: string
  danger: boolean
  resolve: (ok: boolean) => void
}

let confirmQueue: ((request: ConfirmRequest) => void) | null = null

/**
 * 应用内确认框，替代 window.confirm：Promise 风格，确认返回 true，取消/Esc 返回 false。
 * 单例：后一次调用覆盖前一次（前一次按取消结算，与浏览器原生行为一致）。
 * 渲染宿主是 <ConfirmDialogHost/>，挂在各分区入口（ManagerWorkspace / App）。
 */
export function confirmDialog(options: { title: string; body?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (confirmQueue) confirmQueue({ ...options, confirmLabel: options.confirmLabel ?? '确定', danger: options.danger ?? false, resolve })
    else resolve(false)
  })
}

/** 确认框渲染宿主：无挂载时 confirmDialog 直接返回 false。 */
export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)

  useEffect(() => {
    confirmQueue = setRequest
    return () => {
      confirmQueue = null
    }
  }, [])

  useEffect(() => {
    if (!request) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        settle(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [request])

  function settle(ok: boolean) {
    request?.resolve(ok)
    setRequest(null)
  }

  if (!request) return null
  return createPortal(
    <div
      className="modal-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) settle(false)
      }}
    >
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={request.title}>
        <div className="modal-title">{request.title}</div>
        {request.body ? <div className="modal-body">{request.body}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => settle(false)}>
            取消
          </button>
          <button
            type="button"
            className={request.danger ? 'btn btn-danger' : 'btn btn-primary'}
            autoFocus
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
