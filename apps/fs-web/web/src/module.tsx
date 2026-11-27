import type { ReactNode } from 'react'
import { parse } from '@ursi/location'
import type { DirListing } from '@ursi/directory-picker'
import { useWorkspace } from '@ursi/workspace-shell'
import type { ModuleSidebarProps, WorkspaceModule } from '@ursi/workspace-shell'
import { WorkspaceApi, keyName, keySegments } from './api.ts'
import { useEditorStore } from './editor-store.ts'
import { reloadParentOf } from './explorer.tsx'
import { useGitStore } from './git-store.ts'
import { useTreeStore, type FsHostBindings } from './tree-store.ts'
import { FsScope, FsSidebar, FsWorkspace, SIDEBAR_MIN_SIZE } from './parts.tsx'

export interface FsWebModuleOptions {
  apiBaseUrl?: string
  /** 宿主注入的跨模块能力：设备清单与「在此打开终端」。不传则 fs-web 只有本机目录。 */
  host?: FsHostBindings
}

/**
 * fs 模块对外提供的具名能力：由工厂导出，交给组合根注入给需要的模块。
 * 调用方只认识目录路径这类普通值，不需要知道 fs 的 workspaceId、树结构或 API 形状。
 */
export interface FsCommands {
  /** 按位置查找已登记的目录；入参是位置 URI 或本机路径简写，只读，不产生登记。 */
  findRoot: (root: string) => Promise<{ id: string; label: string; root: string } | null>
  /** 按位置打开目录：已登记则激活，未登记则登记后激活。会修改 fs 的目录清单。 */
  openRoot: (root: string) => Promise<{ id: string; label: string; root: string }>
  /**
   * 浏览任意位置的子目录（本机与 ssh 设备），给选目录组件当数据源。
   * 浏览是 fs 的能力：todo、flow 等模块的选目录器经组合根接这一条，自己不加浏览路由。
   */
  browse: (target: string) => Promise<DirListing>
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
export function createFsModule(
  options: FsWebModuleOptions = {},
): WorkspaceModule & { commands: FsCommands } {
  const api = new WorkspaceApi(options.apiBaseUrl ?? '/api/fs-web')

  // 调用方可能给裸路径、URI 或 ~ 简写；统一成规范 URI 再比对，与服务端的判重口径一致。
  const normalize = (root: string) => parse(root).uri

  /**
   * 命令直接走工厂闭包里的 api 与 store，不依赖 Provider 是否已挂载：
   * fs 未在当前 profile 里展开时，跨模块调用依然要能工作。
   */
  const commands: FsCommands = {
    browse: (target) => api.listDir(target),
    findRoot: async (root) => {
      const target = normalize(root)
      const list = await api.workspaces()
      const hit = list.find((item) => normalize(item.root) === target)
      return hit ? { id: hit.id, label: hit.label, root: hit.root } : null
    },
    openRoot: async (root) => {
      const existing = await commands.findRoot(root)
      if (existing) {
        useTreeStore.getState().setApi(api)
        await useTreeStore.getState().loadWorkspaces()
        useTreeStore.getState().selectWorkspace(existing.id)
        return existing
      }
      // 登记会持久化到 fs 的目录清单，属于越权面最大的操作，失败原因必须原样抛给调用方。
      const created = await api.addWorkspace(root)
      useTreeStore.getState().setApi(api)
      await useTreeStore.getState().loadWorkspaces()
      useTreeStore.getState().selectWorkspace(created.id)
      return { id: created.id, label: created.label, root: created.root }
    },
  }

  // host 在工厂里固定引用，FsScope 的 effect 以引用比较，重组根每次渲染传新对象也不会反复注入。
  const host: FsHostBindings = options.host ?? {}
  const Provider = ({ children }: { children: ReactNode }) => (
    <FsScope api={api} host={host}>
      {children}
    </FsScope>
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
    commands,
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
    minSidebarSize: SIDEBAR_MIN_SIZE,
    actions: [],
  }
}
