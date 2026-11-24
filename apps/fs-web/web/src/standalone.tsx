import { useState } from 'react'
import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { FileExplorer, reloadParentOf } from './explorer.tsx'
import { FileView } from './file-view.tsx'
import { useGitStore } from './git-store.ts'

/**
 * 独立预览入口：不依赖工作区外壳（@ursi/workspace-shell），
 * 文件选中由本地 state 管理，其余行为与嵌入模式一致。
 * 模块工厂（module.tsx）仍是嵌入外壳时的正式入口。
 */

export interface FsWebStandaloneOptions {
  apiBaseUrl?: string
}

/** 独立页面：一级目录列表 + 二级文件树（含 Git 徽标），右侧编辑器。 */
export function FsWebStandalone(options: FsWebStandaloneOptions = {}) {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Standalone = () => {
    const [selectedFile, setSelectedFile] = useState<string | null>(null)

    const handleWorkspaceRemoved = (workspaceId: string, wasActive: boolean): void => {
      useEditorStore.getState().closeWorkspaceFiles(workspaceId)
      setSelectedFile((current) =>
        current && keySegments(current).workspaceId === workspaceId ? null : current,
      )
      if (wasActive) useGitStore.getState().reset()
    }

    return (
      <div className="wsx-app">
        <aside className="wsx-app-side">
          <FileExplorer
            api={api}
            onOpenFile={(key) => {
              void useEditorStore.getState().openFile(api, key)
              setSelectedFile(key)
            }}
            onFileDeleted={(key) => {
              useEditorStore.getState().closeFile(key)
              reloadParentOf(key)
              setSelectedFile((current) => (current === key ? null : current))
            }}
            onWorkspaceRemoved={handleWorkspaceRemoved}
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
