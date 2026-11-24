import { useEffect, useState } from 'react'
import { WorkspaceApi, keyName, keyToParent } from './api.ts'
import { injectEditorApi, useEditorStore, registerGitSaveListener } from './editor-store.ts'
import { registerEditorApiInjector, useTreeStore, registerGitRefresh } from './tree-store.ts'
import { useGitStore } from './git-store.ts'
import { GitBar } from './git-bar.tsx'
import { FileTree } from './tree.tsx'
import { DirActions } from './dir-actions.tsx'
import { FileView } from './file-view.tsx'

/**
 * 独立预览入口：不依赖工作区外壳（@ursi/workspace-shell），
 * 文件选中由本地 state 管理，其余行为与嵌入模式一致。
 * 模块工厂（module.tsx）仍是嵌入外壳时的正式入口。
 */

registerEditorApiInjector(injectEditorApi)
registerGitRefresh(useGitStore.getState())
registerGitSaveListener((workspaceId) => {
  void useGitStore.getState().refresh(useTreeStore.getState().api, workspaceId)
})

export interface FsWebStandaloneOptions {
  apiBaseUrl?: string
}

/** 独立页面：左侧文件树（含 Git 徽标），右侧编辑器。 */
export function FsWebStandalone(options: FsWebStandaloneOptions = {}) {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Standalone = () => {
    const workspaces = useTreeStore((state) => state.workspaces)
    const workspaceError = useTreeStore((state) => state.workspaceError)
    const activeWorkspaceId = useTreeStore((state) => state.activeWorkspaceId)
    const selectedDirKey = useTreeStore((state) => state.selectedDirKey)
    const lastError = useTreeStore((state) => state.lastError)
    const clearError = useTreeStore((state) => state.clearError)
    const setApi = useTreeStore((state) => state.setApi)
    const selectWorkspace = useTreeStore((state) => state.selectWorkspace)
    const loadWorkspaces = useTreeStore((state) => state.loadWorkspaces)
    const [selectedFile, setSelectedFile] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)

    useEffect(() => {
      setApi(api)
      void loadWorkspaces()
    }, [setApi, loadWorkspaces])

    useEffect(() => {
      if (activeWorkspaceId) useGitStore.getState().reset()
    }, [activeWorkspaceId])

    const openFile = (key: string): void => {
      void useEditorStore.getState().openFile(api, key)
      setSelectedFile(key)
    }

    const activeWorkspaceLabel = workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.label

    return (
      <div className="wsx-app">
        <aside className="wsx-app-side wsx-sidebar">
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
              setSelectedFile((current) => (current === key ? null : current))
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
        </aside>
        <main className="wsx-app-main">
          {selectedFile ? (
            <FileView fileKey={selectedFile} />
          ) : (
            <div className="wsx-view-empty">在左侧选择文件打开</div>
          )}
        </main>
      </div>
    )
  }
  return Standalone
}

/** keyName 供独立入口的标题使用（预留）。 */
export { keyName }
