import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { FileExplorer, reloadParentOf } from './explorer.tsx'
import { FileView } from './file-view.tsx'
import { useGitStore } from './git-store.ts'
import { useWorkspace } from '@ursi/workspace-shell'
import type { Selection, WorkspaceModule } from '@ursi/workspace-shell'

export interface FsWebModuleOptions {
  apiBaseUrl?: string
}

/** fs-web 模块工厂。apiBaseUrl 由宿主注入，缺省走开发代理。 */
export function createFsModule(options: FsWebModuleOptions = {}): WorkspaceModule {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  const Panel = () => {
    const { select, selection } = useWorkspace()

    // 移除 workspace 的集中善后：关闭其全部文件视图、清指向它的外壳选中；
    // 被移除的是激活目录时同步重置 git 快照。
    const handleWorkspaceRemoved = (workspaceId: string, wasActive: boolean): void => {
      useEditorStore.getState().closeWorkspaceFiles(workspaceId)
      if (
        selection?.kind === 'workspace.file' &&
        keySegments(selection.id).workspaceId === workspaceId
      ) {
        select(null)
      }
      if (wasActive) useGitStore.getState().reset()
    }

    return (
      <div className="wsx-panel">
        <FileExplorer
          api={api}
          onOpenFile={(key) => {
            void useEditorStore.getState().openFile(api, key)
            select({ kind: 'workspace.file', id: key, label: keyName(key) })
          }}
          onFileDeleted={(key) => {
            useEditorStore.getState().closeFile(key)
            reloadParentOf(key)
          }}
          onWorkspaceRemoved={handleWorkspaceRemoved}
        />
      </div>
    )
  }

  const WorkspaceView = ({ selection }: { selection: Selection }) => {
    if (selection.kind !== 'workspace.file') return null
    return <FileView fileKey={selection.id} />
  }

  return {
    id: 'fs-web',
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
    defaultSize: 440,
    minSize: 360,
    collapsedSize: 48,
    selection: {
      kind: 'workspace.file',
      summary: (selected) => keyName(selected.id),
      WorkspaceView,
    },
    actions: [],
  }
}
