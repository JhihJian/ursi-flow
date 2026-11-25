import { useEffect, useState } from 'react'
import { keyToParent } from './api.ts'
import type { WorkspaceApi } from './api.ts'
import { injectEditorApi, useEditorStore, registerGitSaveListener } from './editor-store.ts'
import { registerEditorApiInjector, useTreeStore, registerGitRefresh } from './tree-store.ts'
import { useGitStore } from './git-store.ts'
import { GitBar } from './git-bar.tsx'
import { GitSyncStatus } from './git-sync-status.tsx'
import { FileTree } from './tree.tsx'
import { DirActions } from './dir-actions.tsx'
import { WorkspaceList } from './workspace-list.tsx'

// store 间回调注入：放在 explorer 模块层，module 与 standalone 共用同一份。
registerEditorApiInjector(injectEditorApi)
registerGitRefresh(useGitStore.getState())
registerGitSaveListener((workspaceId) => {
  void useGitStore.getState().refresh(useTreeStore.getState().api, workspaceId)
})

export interface FileExplorerProps {
  /** 宿主构造的 API 客户端（含注入的 apiBaseUrl）。 */
  api: WorkspaceApi
  /** 文件被打开（树内点击）时回调；嵌入模式发布外壳选中，独立模式切本地视图。 */
  onOpenFile: (key: string) => void
  /** 文件删除成功后回调（宿主清理编辑视图）。 */
  onFileDeleted: (key: string) => void
  /** 移除 workspace 后的清理：关闭编辑器、清外壳选中与 git 快照。 */
  onWorkspaceRemoved: (workspaceId: string, wasActive: boolean) => void
  /** 一级列表折叠态（由宿主布局控制，嵌入模式不用）。 */
  listCollapsed?: boolean
  onExpandList?: () => void
}

/**
 * 二级侧边栏布局：一级为记录的目录列表（WorkspaceList），
 * 二级为当前目录的 git 摘要与文件树。
 */
export function FileExplorer({
  api,
  onOpenFile,
  onFileDeleted,
  onWorkspaceRemoved,
  listCollapsed,
  onExpandList,
}: FileExplorerProps) {
  const injectedApi = useTreeStore((state) => state.api)
  const workspaceError = useTreeStore((state) => state.workspaceError)
  const lastError = useTreeStore((state) => state.lastError)
  const clearError = useTreeStore((state) => state.clearError)
  const setApi = useTreeStore((state) => state.setApi)
  const loadWorkspaces = useTreeStore((state) => state.loadWorkspaces)
  const activeWorkspaceId = useTreeStore((state) => state.activeWorkspaceId)
  const selectedDirKey = useTreeStore((state) => state.selectedDirKey)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    setApi(api)
    void loadWorkspaces()
  }, [setApi, loadWorkspaces, api])
  // injectedApi 在首次注入后与 api 相同，仅为订阅需要保留读取。
  void injectedApi

  return (
    <div className="wsx-explorer">
      <WorkspaceList
        onRemove={onWorkspaceRemoved}
        collapsed={listCollapsed}
        onExpand={onExpandList}
      />
      <div className="wsx-tree-pane">
        {workspaceError ? <div className="wsx-panel-error">{workspaceError}</div> : null}
        {lastError ? (
          <button type="button" className="wsx-panel-error" onClick={clearError}>
            {lastError}（点击关闭）
          </button>
        ) : null}
        {activeWorkspaceId ? (
          <>
            <GitBar />
            <FileTree
              onOpenFile={onOpenFile}
              onFileDeleted={onFileDeleted}
              onCreateDir={() => setCreating(true)}
            />
            <DirActions
              selectedDirKey={selectedDirKey}
              creating={creating}
              onCreatingDone={() => setCreating(false)}
            />
            <GitSyncStatus />
          </>
        ) : (
          <div className="wsx-explorer-empty">从左侧选择目录，或用左侧「+」添加</div>
        )}
      </div>
    </div>
  )
}

/** 删除文件后刷新其父目录（树与 DirActions 共用的善后）。 */
export function reloadParentOf(key: string): void {
  const parent = keyToParent(key)
  void useTreeStore.getState().reloadDir(parent?.parentKey ?? key)
}
