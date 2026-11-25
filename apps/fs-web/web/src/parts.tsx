import { useEffect, type ReactNode } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import type { WorkspaceApi } from './api.ts'
import { FileExplorer } from './explorer.tsx'
import { FileView } from './file-view.tsx'
import { useEditorStore } from './editor-store.ts'
import { useTreeStore } from './tree-store.ts'

/** 模块级 api 注入：侧边栏与工作区共用同一份，折叠侧边栏时工作区仍能保存。 */
export function FsScope({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  const setApi = useTreeStore((state) => state.setApi)
  useEffect(() => {
    setApi(api)
  }, [setApi, api])
  return <>{children}</>
}

export interface FsSidebarProps extends ModuleSidebarProps {
  api: WorkspaceApi
  onOpenFile: (key: string) => void
  onFileDeleted: (key: string) => void
  onWorkspaceRemoved: (workspaceId: string, wasActive: boolean) => void
}

/** fs 模块的侧边栏：目录列表 + 文件树，折叠为一条横向窄条。 */
export function FsSidebar({
  api,
  onOpenFile,
  onFileDeleted,
  onWorkspaceRemoved,
  collapsed,
  collapse,
  expand,
}: FsSidebarProps) {
  const editors = useEditorStore((state) => state.editors)
  const open = Object.keys(editors).length
  const dirty = Object.values(editors).filter((entry) => entry.dirty).length

  return (
    <SidebarFrame
      title="文件"
      collapsed={collapsed}
      collapse={collapse}
      expand={expand}
      items={
        dirty > 0
          ? [
              { label: '未保存', value: String(dirty) },
              { label: '打开', value: String(open) },
            ]
          : [{ label: '打开', value: String(open) }]
      }
    >
      <div className="wsx-panel wsx-panel-fill">
        <FileExplorer
          api={api}
          onOpenFile={onOpenFile}
          onFileDeleted={onFileDeleted}
          onWorkspaceRemoved={onWorkspaceRemoved}
        />
      </div>
    </SidebarFrame>
  )
}

/** fs 模块的工作区：只渲染打开的文件，不含标题区。 */
export function FsWorkspace({ fileKey }: { fileKey: string | null }) {
  return (
    <div className="wsx-panel">
      {fileKey ? (
        <FileView fileKey={fileKey} />
      ) : (
        <div className="wsx-view-empty">在左侧选择文件打开</div>
      )}
    </div>
  )
}
