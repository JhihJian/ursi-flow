import { useEffect, useState } from 'react'
import { WorkspaceApi, keyName, keyToParent } from './api.ts'
import { injectEditorApi, useEditorStore } from './editor-store.ts'
import { registerEditorApiInjector, useTreeStore, registerGitRefresh, useGitRefreshOf } from './tree-store.ts'
import { useGitStore } from './git-store.ts'
import { GitBar } from './git-bar.tsx'
import { registerGitSaveListener } from './editor-store.ts'
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

export interface WorkspaceWebModuleOptions {
  apiBaseUrl?: string
}

/** workspace-web 模块工厂。apiBaseUrl 由宿主注入，缺省走开发代理。 */
export function createWorkspaceModule(options: WorkspaceWebModuleOptions = {}): WorkspaceModule {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/workspace-web')

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
    const [confirm, confirmDialog] = useInlineConfirm()

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

    const reloadParent = (key: string): void => {
      const parent = keyToParent(key)
      void useTreeStore.getState().reloadDir(parent?.parentKey ?? key)
    }

    return (
      <div className="wsx-panel">
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
            reloadParent(key)
          }}
        />
        <DirActions selectedDirKey={selectedDirKey} confirm={confirm} />
        {confirmDialog}
      </div>
    )
  }

  const WorkspaceView = ({ selection }: { selection: Selection }) => {
    if (selection.kind !== 'workspace.file') return null
    return <FileView fileKey={selection.id} />
  }

  return {
    id: 'workspace-web',
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
