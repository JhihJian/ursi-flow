import { useEffect, useRef } from 'react'

import { useUnsavedChanges } from '@/shared/hooks/use-unsaved-changes'
import { cn } from '@/shared/lib/utils'

import { ExplorerContextMenu } from './explorer/ExplorerContextMenu'
import { ExplorerTabs } from './explorer/ExplorerTabs'
import { ExplorerToolbar } from './explorer/ExplorerToolbar'
import { ExplorerTree } from './explorer/ExplorerTree'
import { CompactEditorHeader, EditorToolbarActions, FileEditor } from './explorer/FileEditor'
import { isMarkdownPath } from './explorer/paths'
import type { Directory } from '@/modules/directories/api'
import { UnsavedDialog } from './explorer/UnsavedDialog'
import { useCompact } from './explorer/use-compact'
import { useExplorer } from './explorer/use-explorer'

export interface ExplorerProps {
  /** 父组件提供的目录服务，资源管理器不自行实现 HTTP 客户端。 */
  directory: Directory
  /** 只显示该路径下的条目；目录 API 仍使用包根相对路径。 */
  root?: string
  /** 首次载入后自动打开的文件。 */
  initialPath?: string
  onDirtyChange?: (dirty: boolean) => void
}

function RouteGuard({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(() => dirty)
  return null
}

const EXPANDED_WIDTH = '240px'
const COLLAPSED_WIDTH = '28px'

/**
 * 通用文件资源管理器：目录树、标签页、Markdown 编辑预览与上传。
 * 窄屏（容器宽度小于 640px）切换为文件列表与编辑器分步显示。
 */
export function Explorer({ directory, root, initialPath, onDirtyChange }: ExplorerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dirInput = useRef<HTMLInputElement | null>(null)
  const compact = useCompact(panelRef)
  const explorer = useExplorer({ directory, root, initialPath, compact, fileInput, dirInput })

  const hasDraft = explorer.dirtyPaths.length > 0
  useEffect(() => { onDirtyChange?.(hasDraft) }, [hasDraft, onDirtyChange])

  // 目录选择只认 webkitdirectory 属性，React 不声明该属性，挂载后补上。
  useEffect(() => {
    const node = dirInput.current
    if (!node) return
    node.setAttribute('webkitdirectory', '')
    node.setAttribute('directory', '')
  }, [])
  const doc = explorer.doc
  const markdown = Boolean(doc && !doc.binary && isMarkdownPath(doc.path))
  const collapsed = explorer.collapsed && !compact
  const showTree = !collapsed && (!compact || explorer.step === 'list')
  const showEditor = !compact || explorer.step === 'edit'

  return (
    <section
      ref={panelRef}
      data-testid="patch-explorer"
      data-compact={compact ? 'true' : 'false'}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface"
    >
      {!onDirtyChange && <RouteGuard dirty={hasDraft} />}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        data-testid="explorer-upload-input"
        onChange={explorer.onUploadPicked}
      />
      <input
        ref={dirInput}
        type="file"
        multiple
        className="hidden"
        data-testid="explorer-import-input"
        onChange={explorer.onImportPicked}
      />

      <div
        className={cn('min-h-0 flex-1 overflow-hidden', compact ? 'flex flex-col' : 'grid')}
        style={compact ? undefined : { gridTemplateColumns: `${collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH} minmax(0, 1fr)` }}
      >
        <div className={cn('flex min-h-0 min-w-0 flex-col', compact ? 'flex-1' : 'border-r border-line')}>
          <ExplorerToolbar
            compact={compact}
            collapsed={collapsed}
            onNewFile={() => explorer.startCreate('file', explorer.base)}
            onNewFolder={() => explorer.startCreate('folder', explorer.base)}
            onUpload={() => explorer.pickUpload(explorer.base)}
            onImport={() => explorer.pickImport(explorer.base)}
            onToggleCollapse={explorer.toggleCollapsed}
          />
          {showTree && (
            <ExplorerTree
              rows={explorer.rows}
              base={explorer.base}
              expanded={explorer.expanded}
              activePath={explorer.active}
              selected={explorer.selected}
              compact={compact}
              loading={explorer.treeLoading}
              error={explorer.treeError}
              renaming={explorer.renaming}
              renameName={explorer.renameName}
              creating={explorer.creating}
              createName={explorer.createName}
              onRetry={explorer.reload}
              onToggleDir={explorer.toggleDir}
              onOpen={explorer.requestOpen}
              onSelect={explorer.setSelected}
              onRowContext={explorer.openRowContext}
              onBlankContext={explorer.openBlankContext}
              onStartRename={explorer.startRename}
              onRenameName={explorer.setRenameName}
              onCommitRename={explorer.commitRename}
              onCancelRename={explorer.cancelRename}
              onCreateName={explorer.setCreateName}
              onCommitCreate={explorer.commitCreate}
              onCancelCreate={explorer.cancelCreate}
              onCreateFileIn={explorer.onCreate}
              onCreateFolderIn={explorer.onCreateFolder}
              onDelete={explorer.onDeleteRow}
            />
          )}
        </div>

        {showEditor && (
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            {compact ? (
              <CompactEditorHeader
                path={doc?.path ?? ''}
                dirty={explorer.dirty}
                saving={explorer.saving === explorer.active}
                markdown={markdown}
                viewMode={explorer.viewMode}
                onBack={explorer.requestBackToList}
                onSave={() => { void explorer.saveActive() }}
                onViewMode={explorer.setViewMode}
              />
            ) : (
              <div className="flex min-h-8 shrink-0 items-stretch border-b border-line" data-testid="explorer-editor-toolbar">
                <ExplorerTabs
                  tabs={explorer.tabs}
                  active={explorer.active}
                  dirtyPaths={explorer.dirtyPaths}
                  onSelect={explorer.setActiveTab}
                  onClose={explorer.closeTab}
                />
                <EditorToolbarActions
                  markdown={markdown}
                  viewMode={explorer.viewMode}
                  dirty={explorer.dirty}
                  saving={explorer.saving === explorer.active}
                  onSave={() => { void explorer.saveActive() }}
                  onViewMode={explorer.setViewMode}
                />
              </div>
            )}
            <FileEditor
              doc={doc ?? null}
              viewMode={explorer.viewMode}
              compact={compact}
              stats={explorer.stats}
              onChange={explorer.updateText}
              onRetry={path => { void explorer.reloadDoc(path) }}
              onDownload={path => { void explorer.downloadPath(path) }}
            />
          </div>
        )}
      </div>

      {explorer.ctx && (
        <ExplorerContextMenu
          x={explorer.ctx.x}
          y={explorer.ctx.y}
          target={explorer.ctx.target}
          onAction={explorer.onCtxAction}
          onClose={explorer.closeCtx}
        />
      )}

      {explorer.pending && (
        <UnsavedDialog
          path={explorer.pending.path}
          saving={explorer.saving === explorer.pending.path}
          onSave={() => { void explorer.pendingSave() }}
          onDiscard={explorer.pendingDiscard}
          onCancel={explorer.pendingCancel}
        />
      )}
    </section>
  )
}
