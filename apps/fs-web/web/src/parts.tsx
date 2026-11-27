import { useEffect, type ReactNode } from 'react'
import { SidebarFrame, type ModuleSidebarProps } from '@ursi/workspace-shell'
import type { WorkspaceApi } from './api.ts'
import { FileExplorer } from './explorer.tsx'
import { FileView } from './file-view.tsx'
import { useEditorStore } from './editor-store.ts'
import { useTreeStore, type FsHostBindings } from './tree-store.ts'

/** 模块级注入：api 与宿主能力，侧边栏与工作区共用同一份，折叠侧边栏时工作区仍能保存。 */
const NO_HOST: FsHostBindings = {}

export function FsScope({
  api,
  host = NO_HOST,
  children,
}: {
  api: WorkspaceApi
  /** 不传表示独立运行：没有设备切换，也没有「在此打开终端」。 */
  host?: FsHostBindings
  children: ReactNode
}) {
  const setApi = useTreeStore((state) => state.setApi)
  const setHost = useTreeStore((state) => state.setHost)
  useEffect(() => {
    setApi(api)
  }, [setApi, api])
  useEffect(() => {
    setHost(host)
  }, [setHost, host])
  return <>{children}</>
}

/**
 * 侧边栏最小宽度，嵌入外壳与独立入口共用。
 * 侧栏左侧固定 144px 目录列 + 8px 间距，右侧 git 摘要条不换行：分支、变更计数、
 * ↑↓ 分段按钮加右侧 6px 留白约需 172px，整栏至少 144 + 8 + 172 = 324，取 340
 * 留出多位数的计数余量。分支名过长时自己省略号截断，不把计数与 ↑↓ 顶出可视区。
 */
export const SIDEBAR_MIN_SIZE = 340

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
