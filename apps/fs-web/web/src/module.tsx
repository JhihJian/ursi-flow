import type { ReactNode } from 'react'
import { useWorkspace } from '@ursi/workspace-shell'
import type { ModuleSidebarProps, WorkspaceModule } from '@ursi/workspace-shell'
import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { reloadParentOf } from './explorer.tsx'
import { useGitStore } from './git-store.ts'
import { FsScope, FsSidebar, FsWorkspace } from './parts.tsx'

export interface FsWebModuleOptions {
  apiBaseUrl?: string
}

const KIND = 'workspace.file'

/** 状态栏：打开数、未保存数与当前文件名。 */
function FsStatus() {
  const editors = useEditorStore((state) => state.editors)
  const { selection } = useWorkspace()
  const open = Object.keys(editors).length
  const dirty = Object.values(editors).filter((entry) => entry.dirty).length
  const name = selection?.kind === KIND ? keyName(selection.id) : ''
  return (
    <span>
      文件 {open}
      {dirty > 0 ? ` · 未保存 ${dirty}` : ''}
      {name ? ` · ${name}` : ''}
    </span>
  )
}

/** fs-web 模块工厂。apiBaseUrl 由宿主注入，缺省走开发代理。 */
export function createFsModule(options: FsWebModuleOptions = {}): WorkspaceModule {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Provider = ({ children }: { children: ReactNode }) => (
    <FsScope api={api}>{children}</FsScope>
  )

  const Sidebar = ({ collapsed, collapse, expand }: ModuleSidebarProps) => {
    const { select, selection } = useWorkspace()

    // 移除 workspace 的集中善后：关闭其全部文件视图、清指向它的外壳选中；
    // 被移除的是激活目录时同步重置 git 快照。
    const handleWorkspaceRemoved = (workspaceId: string, wasActive: boolean): void => {
      useEditorStore.getState().closeWorkspaceFiles(workspaceId)
      if (selection?.kind === KIND && keySegments(selection.id).workspaceId === workspaceId) {
        select(null)
      }
      if (wasActive) useGitStore.getState().reset()
    }

    return (
      <FsSidebar
        api={api}
        collapsed={collapsed}
        collapse={collapse}
        expand={expand}
        onOpenFile={(key) => {
          void useEditorStore.getState().openFile(api, key)
          select({ kind: KIND, id: key, label: keyName(key) })
        }}
        onFileDeleted={(key) => {
          useEditorStore.getState().closeFile(key)
          reloadParentOf(key)
          if (selection?.kind === KIND && selection.id === key) select(null)
        }}
        onWorkspaceRemoved={handleWorkspaceRemoved}
      />
    )
  }

  const Workspace = () => {
    const { selection } = useWorkspace()
    return <FsWorkspace fileKey={selection?.kind === KIND ? selection.id : null} />
  }

  return {
    id: 'fs-web',
    title: '文件',
    Provider,
    Sidebar,
    Workspace,
    context: {
      kind: KIND,
      summary: (selected) => keyName(selected.id),
      Status: FsStatus,
    },
    sidebarDefaultSize: 360,
    sidebarMinSize: 200,
    sidebarMaxSize: 760,
    actions: [],
  }
}
