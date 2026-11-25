import { useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, usePanelRef, type PanelSize } from 'react-resizable-panels'
import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { reloadParentOf } from './explorer.tsx'
import { useGitStore } from './git-store.ts'
import { FsScope, FsSidebar, FsWorkspace } from './parts.tsx'

/**
 * 独立预览入口：不依赖工作区外壳（@ursi/workspace-shell）的固定骨架，
 * 自带一栏可折叠侧边栏与工作区；模块组件与嵌入模式完全相同。
 */

export interface FsWebStandaloneOptions {
  apiBaseUrl?: string
}

const SIDEBAR_COLLAPSED_SIZE = 28

export function FsWebStandalone(options: FsWebStandaloneOptions = {}) {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Standalone = () => {
    const [selectedFile, setSelectedFile] = useState<string | null>(null)
    const panelRef = usePanelRef()
    const [collapsed, setCollapsed] = useState(false)
    const lastExpanded = useRef(420)

    useEffect(() => {
      if (panelRef.current?.isCollapsed()) setCollapsed(true)
    }, [panelRef])

    const onResize = (size: PanelSize) => {
      const next = size.inPixels <= SIDEBAR_COLLAPSED_SIZE + 1
      if (!next) lastExpanded.current = size.inPixels
      setCollapsed(next)
    }

    const handleWorkspaceRemoved = (workspaceId: string, wasActive: boolean): void => {
      useEditorStore.getState().closeWorkspaceFiles(workspaceId)
      setSelectedFile((current) =>
        current && keySegments(current).workspaceId === workspaceId ? null : current,
      )
      if (wasActive) useGitStore.getState().reset()
    }

    return (
      <FsScope api={api}>
        <Group orientation="horizontal" className="wsx-app">
          <Panel
            id="fs-side"
            className="wsx-app-side"
            panelRef={panelRef}
            defaultSize={lastExpanded.current}
            minSize={280}
            maxSize={720}
            collapsible
            collapsedSize={SIDEBAR_COLLAPSED_SIZE}
            groupResizeBehavior="preserve-pixel-size"
            onResize={onResize}
          >
            <FsSidebar
              api={api}
              collapsed={collapsed}
              collapse={() => panelRef.current?.collapse()}
              expand={() => panelRef.current?.resize(lastExpanded.current)}
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
            <FsWorkspace fileKey={selectedFile} />
          </Panel>
        </Group>
      </FsScope>
    )
  }
  return Standalone
}

/** keyName 供独立入口的标题使用（预留）。 */
export { keyName }
