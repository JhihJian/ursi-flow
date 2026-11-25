import { useState } from 'react'
import { useWorkspace } from './context'
import type { WorkspaceAction, WorkspaceModule, WorkspaceView } from './contracts'
import { findWorkspaceView, summaryFor } from './region'
import './shell.css'

/** 区域里的主区内容：把选中派给匹配视图，未匹配时占位。外层 Panel 由区域统一提供。 */
export function WorkspaceRegionBody({ modules, views }: { modules: WorkspaceModule[]; views: WorkspaceView[] }) {
  const { selection } = useWorkspace()
  const view = findWorkspaceView(modules, views, selection)

  return (
    <div className="ws-workspace">
      {view ?? (
        <div className="ws-placeholder">
          <span className="ws-placeholder-title">Workspace</span>
          <span className="ws-placeholder-text">
            {selection
              ? `No workspace view is registered for ${selection.kind}.`
              : 'Select something in a panel to see its details here.'}
          </span>
        </div>
      )}
    </div>
  )
}

/** 区域里的操作栏内容：按选中列出 applicable actions。外层 Panel 由区域统一提供。 */
export function ActionsRegionBody({ modules }: { modules: WorkspaceModule[] }) {
  const { selection } = useWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const items = modules.flatMap((module) =>
    (module.actions ?? []).map((action) => ({ module, action })),
  )
  const applicable = selection
    ? items.filter(({ action }) => action.appliesTo(selection))
    : []
  const summary = selection ? (summaryFor(modules, selection) ?? selection.id) : 'Nothing selected'

  const run = async (action: WorkspaceAction) => {
    if (!selection) return
    if (action.confirm && !window.confirm(action.confirm)) return
    setError(null)
    setBusy(action.id)
    try {
      await action.run(selection)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ws-actions">
      <div className="ws-actions-head">
        <span className="ws-actions-title">Actions</span>
      </div>
      <p className="ws-actions-selection">{summary}</p>
      <div className="ws-actions-list">
        {applicable.length === 0 ? (
          <span className="ws-actions-empty">No actions for the current selection.</span>
        ) : (
          applicable.map(({ module, action }) => {
            const reason = selection ? (action.disabledReason?.(selection) ?? null) : null
            return (
              <button
                key={`${module.id}:${action.id}`}
                type="button"
                className="ws-action"
                disabled={Boolean(reason) || busy !== null}
                title={reason ?? undefined}
                onClick={() => void run(action)}
              >
                {busy === action.id ? 'Working…' : action.label}
              </button>
            )
          })
        )}
        {error ? <span className="ws-actions-error">{error}</span> : null}
      </div>
    </div>
  )
}
