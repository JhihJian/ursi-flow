import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { FileExplorer, reloadParentOf } from './explorer.tsx'
import { FileView } from './file-view.tsx'
import { useGitStore } from './git-store.ts'

/**
 * 独立预览入口：不依赖工作区外壳（@ursi/workspace-shell），
 * 文件选中由本地 state 管理，其余行为与嵌入模式一致。
 * 侧边栏用 react-resizable-panels 拖宽，拖到折叠宽度以下或点 « 收起为竖排书脊。
 * 模块工厂（module.tsx）仍是嵌入外壳时的正式入口（拖宽/折叠由外壳管理）。
 */

export interface FsWebStandaloneOptions {
  apiBaseUrl?: string
}

const SIDEBAR_COLLAPSED_SIZE = 28

/** 独立页面：一级目录列表 + 二级文件树（含 Git 徽标），右侧编辑器。 */
export function FsWebStandalone(options: FsWebStandaloneOptions = {}) {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Standalone = () => {
    const [selectedFile, setSelectedFile] = useState<string | null>(null)
    const sideRef = usePanelRef()
    const [sideCollapsed, setSideCollapsed] = useState(false)
    const lastExpandedWidth = useRef(420)

    const collapseSide = () => {
      const panel = sideRef.current
      if (!panel) return
      const { inPixels } = panel.getSize()
      if (inPixels > SIDEBAR_COLLAPSED_SIZE) lastExpandedWidth.current = inPixels
      panel.collapse()
    }
    const expandSide = () => {
      sideRef.current?.resize(lastExpandedWidth.current)
    }

    useEffect(() => {
      const panel = sideRef.current
      if (panel) setSideCollapsed(panel.isCollapsed())
    }, [sideRef])

    const handleWorkspaceRemoved = (workspaceId: string, wasActive: boolean): void => {
      useEditorStore.getState().closeWorkspaceFiles(workspaceId)
      setSelectedFile((current) =>
        current && keySegments(current).workspaceId === workspaceId ? null : current,
      )
      if (wasActive) useGitStore.getState().reset()
    }

    return (
      <Group orientation="horizontal" className="wsx-app">
        <Panel
          id="fs-side"
          className={sideCollapsed ? 'wsx-app-side wsx-app-side--collapsed' : 'wsx-app-side'}
          panelRef={sideRef}
          defaultSize={420}
          minSize={280}
          maxSize={720}
          collapsible
          collapsedSize={SIDEBAR_COLLAPSED_SIZE}
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            const collapsed = size.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1
            if (!collapsed) lastExpandedWidth.current = size.inPixels
            setSideCollapsed(collapsed)
          }}
        >
          <FileExplorer
            api={api}
            listCollapsed={sideCollapsed}
            onExpandList={expandSide}
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
        </Panel>
        <Separator className="wsx-separator" title="拖动调整宽度，拖到底或点 « 折叠" />
        <Panel id="fs-main" className="wsx-app-main" minSize={280}>
          {selectedFile ? (
            <FileView fileKey={selectedFile} />
          ) : (
            <div className="wsx-view-empty">在左侧选择文件打开</div>
          )}
        </Panel>
      </Group>
    )
  }
  return Standalone
}

/** keyName 供独立入口的标题使用（预留）。 */
export { keyName }
