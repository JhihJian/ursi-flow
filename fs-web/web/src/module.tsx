import { useEffect, useState } from 'react'
import { WorkspaceApi, keyName, keyToParent } from './api.ts'
import { injectEditorApi, useEditorStore, registerGitSaveListener } from './editor-store.ts'
import { registerEditorApiInjector, useTreeStore, registerGitRefresh } from './tree-store.ts'
import { useGitStore } from './git-store.ts'
import { GitBar } from './git-bar.tsx'
import { FileTree } from './tree.tsx'
import { DirActions } from './dir-actions.tsx'
import { FileView } from './file-view.tsx'
import { useWorkspace } from '@ursi/workspace-shell'
import type { Selection, WorkspaceModule } from '@ursi/workspace-shell'

registerEditorApiInjector(injectEditorApi)
registerGitRefresh(useGitStore.getState())
registerGitSaveListener((workspaceId) => {
  void useGitStore.getState().refresh(useTreeStore.getState().api, workspaceId)
})

export interface FsWebModuleOptions {
  apiBaseUrl?: string
}

/** fs-web 模块工厂。apiBaseUrl 由宿主注入，缺省走开发代理。 */
export function createFsModule(options: FsWebModuleOptions = {}): WorkspaceModule {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Panel = () => {
    const workspaces = useTreeStore((state) => state.workspaces)
    const workspaceError = useTreeStore((state) => state.workspaceError)
    const activeWorkspaceId = useTreeStore((state) => state.activeWorkspaceId)
    const selectedDirKey = useTreeStore((state) => state.selectedDirKey)
    const lastError = useTreeStore((state) => state.lastError)
    const clearError = useTreeStore((state) => state.clearError)
    const setApi = useTreeStore((state) => state.setApi)
    const selectWorkspace = useTreeStore((state) => state.selectWorkspace)
    const loadWorkspaces = useTreeStore((state) => state.loadWorkspaces)
    const { select } = useWorkspace()
    const [creating, setCreating] = useState(false)

    useEffect(() => {
      setApi(api)
      void loadWorkspaces()
    }, [setApi, loadWorkspaces])

    // 切换 workspace 时清空 git 快照；selectWorkspace 内部会立即发起 refresh。
    useEffect(() => {
      if (activeWorkspaceId) useGitStore.getState().reset()
    }, [activeWorkspaceId])

    const openFile = (key: string): void => {
      void useEditorStore.getState().openFile(api, key)
      select({ kind: 'workspace.file', id: key, label: keyName(key) })
    }

    const activeWorkspaceLabel = workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.label

    return (
      <div className="wsx-panel">
        <div className="wsx-sidebar">
          <div className="wsx-sidebar-head">
            <h2 className="wsx-sidebar-title">{activeWorkspaceLabel ?? 'Workspaces'}</h2>
            <select
              value={activeWorkspaceId ?? ''}
              aria-label="切换工作区"
              onChange={(event) => selectWorkspace(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id} disabled={!workspace.ready}>
                  {workspace.label}
                </option>
              ))}
            </select>
          </div>
          {workspaceError ? <div className="wsx-panel-error">{workspaceError}</div> : null}
          {lastError ? (
            <button type="button" className="wsx-panel-error" onClick={clearError}>
              {lastError}（点击关闭）
            </button>
          ) : null}
          <GitBar />
          <FileTree
            onOpenFile={openFile}
            onFileDeleted={(key) => {
              useEditorStore.getState().closeFile(key)
              const parent = keyToParent(key)
              void useTreeStore.getState().reloadDir(parent?.parentKey ?? key)
            }}
            onCreateDir={() => setCreating(true)}
          />
          <DirActions
            selectedDirKey={selectedDirKey}
            creating={creating}
            onCreatingDone={() => setCreating(false)}
          />
        </div>
      </div>
    )
  }

  const WorkspaceView = ({ selection }: { selection: Selection }) => {
    if (selection.kind !== 'workspace.file') return null
    return <FileView fileKey={selection.id} />
  }

  return {
    id: 'fs-web',
    title: '文件',
    Panel,
    useCollapsedSummary: () => {
      const entries = useEditorStore((state) => state.editors)
      const openCount = Object.keys(entries).length
      const dirtyCount = Object.values(entries).filter((entry) => entry.dirty).length
      if (dirtyCount > 0) {
        return { title: '文件', items: [{ label: '未保存', value: String(dirtyCount) }] }
      }
      if (openCount > 0) {
        return { title: '文件', items: [{ label: '打开', value: String(openCount) }] }
      }
      return { title: '文件', items: [{ label: '状态', value: '浏览' }] }
    },
    defaultSize: 420,
    minSize: 280,
    collapsedSize: 48,
    selection: {
      kind: 'workspace.file',
      summary: (selected) => keyName(selected.id),
      WorkspaceView,
    },
    actions: [],
  }
}
