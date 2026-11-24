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

interface ConfirmState {
  message: string
  resolve: (ok: boolean) => void
}

/** 破坏性操作确认 hook：返回 confirm 函数与对话框节点。 */
function useInlineConfirm(): [(message: string) => Promise<boolean>, React.ReactNode] {
  const [state, setState] = useState<ConfirmState | null>(null)
  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      setState({ message, resolve })
    })
  const onClose = (ok: boolean): void => {
    state?.resolve(ok)
    setState(null)
  }
  const dialog = state ? (
    <div className="wsx-confirm">
      <div className="wsx-confirm-text">{state.message}</div>
      <div className="wsx-confirm-buttons">
        <button type="button" onClick={() => onClose(true)}>删除</button>
        <button type="button" onClick={() => onClose(false)}>取消</button>
      </div>
    </div>
  ) : null
  return [confirm, dialog]
}

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
    const [confirm, confirmDialog] = useInlineConfirm()

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

    return (
      <div className="wsx-app">
        <div className="wsx-app-side">
          <div className="wsx-workspace-bar">
            <select value={activeWorkspaceId ?? ''} onChange={(event) => selectWorkspace(event.target.value)}>
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
            confirm={confirm}
            onFileDeleted={(key) => {
              useEditorStore.getState().closeFile(key)
              setSelectedFile((current) => (current === key ? null : current))
              const parent = keyToParent(key)
              void useTreeStore.getState().reloadDir(parent?.parentKey ?? key)
            }}
          />
          <DirActions selectedDirKey={selectedDirKey} confirm={confirm} />
          {confirmDialog}
        </div>
        <div className="wsx-app-main">
          {selectedFile ? (
            <FileView fileKey={selectedFile} />
          ) : (
            <div className="wsx-view-empty">在左侧选择文件打开</div>
          )}
        </div>
      </div>
    )
  }
  return Standalone
}

/** keyName 供独立入口的标题使用（预留）。 */
export { keyName }
