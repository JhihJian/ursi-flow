import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { useOptionalWorkspace, type WorkspaceModule } from '@ursi/workspace-shell'
import { createSessionsApi } from './api'
import { SessionsSidebar } from './components/SessionsSidebar'
import { shortRoot, sessionTitle } from './lib/format'
import {
  SessionsProvider,
  useSessionsController,
  type SessionsController,
  type SessionsControllerOptions,
} from './sessions-context'

/** 本模块对外发布的选中类型：pi 会话。 */
export const PI_SESSION_KIND = 'pi.session'

/**
 * 轨迹组件库单文件约 1MB，只在工作区需要时加载，
 * 侧边栏与首屏不背这份依赖（组件库本身会懒加载它）。
 */
const SessionWorkspaceLazy = lazy(() =>
  import('./components/SessionWorkspace').then((module) => ({ default: module.SessionWorkspace })),
)

function WorkspaceFallback() {
  return (
    <div className="pisess pisess-workspace">
      <div className="viewer-center">
        <span className="viewer-hint">加载轨迹视图…</span>
      </div>
    </div>
  )
}

/**
 * 把模块内的选中同步到外壳；侧边栏、工作区、状态栏读同一份。
 * 清空时只清除属于本模块的选中，避免模块挂载时抹掉别的模块发布的选择。
 */
function SelectionBridge() {
  const { selected } = useSessionsController()
  const workspace = useOptionalWorkspace()
  const select = workspace?.select
  // 外壳那份选中在两次渲染之间可能已被别的模块改写，这里不能在 effect 里读旧闭包。
  const current = useRef(workspace?.selection ?? null)
  current.current = workspace?.selection ?? null

  useEffect(() => {
    if (!select) return
    if (selected) {
      select({ kind: PI_SESSION_KIND, id: selected.id, label: sessionTitle(selected) })
      return
    }
    if (current.current?.kind === PI_SESSION_KIND) select(null)
  }, [selected, select])

  return null
}

/**
 * 状态栏：会话总数与当前选中的会话。
 * 总数从列表里取，未加载完时显示破折号而不是 0，避免误读成空目录。
 */
function SessionsStatus() {
  const { listing, selected, root } = useSessionsController()
  const total = listing ? String(listing.sessions.length) : '—'
  return (
    <span>
      Sessions {total}
      {selected ? ` · ${selected.projectName} · ${sessionTitle(selected)}` : ''}
      {root ? ` · ${shortRoot(root)}` : ''}
    </span>
  )
}

/** 跨模块能力：打开某个会话根目录，或直接定位到一条会话。 */
export interface PiSessionsCommands {
  openRoot: (root: string) => Promise<{ id: string; label: string }>
  /**
   * 打开一条会话：按会话文件优先、id 兜底定位；根目录不同则先切根。
   * 找不到时抛错，不发半截请求。
   */
  openSession: (input: { root?: string; id?: string; sessionFile?: string }) => Promise<{ id: string; label: string }>
}

export type PiSessionsModuleOptions = SessionsControllerOptions & {
  /** 在对话模块继续这条历史会话；未注入时不显示该动作。 */
  resumeSessionInChat?: (input: { sessionFile: string }) => Promise<unknown>
}

/**
 * pi 会话浏览模块工厂。
 *
 * 接口前缀、storageKey、初始根目录都由宿主注入；模块不读宿主 store、不写全局键。
 * 侧边栏与工作区在 DOM 上分属两块，共享状态放在 Provider 里（纯上下文，不渲染 DOM）。
 */
export function createPiSessionsModule(
  options: PiSessionsModuleOptions = {},
): WorkspaceModule & { commands: PiSessionsCommands } {
  // 命令需要拿到当前挂载的 controller：由 Provider 内的注册组件赋值，卸载时清空。
  let controller: SessionsController | null = null
  const api = createSessionsApi(options.apiBaseUrl ?? '/api')

  function RegisterController({ current }: { current: SessionsController }) {
    useEffect(() => {
      controller = current
      return () => {
        if (controller === current) controller = null
      }
    }, [current])
    return null
  }

  /** 桥接组件从 context 取 controller，交给上面的注册逻辑。 */
  function ControllerBridge() {
    const current = useSessionsController()
    return <RegisterController current={current} />
  }

  const Provider = ({ children }: { children: ReactNode }) => (
    <SessionsProvider options={options}>
      <ControllerBridge />
      <SelectionBridge />
      {children}
    </SessionsProvider>
  )

  const Workspace = () => (
    <Suspense fallback={<WorkspaceFallback />}>
      <SessionWorkspaceLazy />
    </Suspense>
  )

  const commands: PiSessionsCommands = {
    async openSession(input) {
      if (!controller) throw new Error('会话模块未挂载')
      const root = input.root?.trim()
      const id = input.id?.trim()
      const sessionFile = input.sessionFile?.trim()
      if (!id && !sessionFile) throw new Error('需要会话 id 或会话文件路径')
      // 根目录不一样时先校验再切，避免停在一个不可读的目录上。
      if (root) await api.fetchBrowse(root)
      controller.openSession({ root, id, sessionFile })
      return { id: id ?? sessionFile ?? '', label: shortRoot(root ?? controller.root ?? '') }
    },
    async openRoot(root: string) {
      const target = root.trim()
      if (!target) throw new Error('目录不能为空')
      // 没有挂载就没有界面可切，先失败，别白跑一次扫描。
      if (!controller) throw new Error('会话模块未挂载')
      // 再用目录浏览接口校验：不存在、非绝对路径或不是目录都会在这里报出来，
      // 不会让侧边栏停在一个错的根目录上。它只列一层子目录，比整目录扫描便宜。
      await api.fetchBrowse(target)
      controller.setRoot(target)
      return { id: target, label: shortRoot(target) }
    },
  }

  const resumeInChat = options.resumeSessionInChat

  return {
    id: 'pi-sessions',
    title: 'Sessions',
    Provider,
    Sidebar: SessionsSidebar,
    Workspace,
    context: {
      kind: PI_SESSION_KIND,
      summary: (selection) => selection.label ?? `Session ${selection.id}`,
      Status: SessionsStatus,
    },
    /** 折叠即卸载，重开时按当前根目录重新扫描；轨迹不需要保活。 */
    keepMounted: false,
    actions: resumeInChat
      ? [
          {
            id: 'resume-in-chat',
            label: '在对话里继续',
            appliesTo: (selection) => selection?.kind === PI_SESSION_KIND,
            run: async (selection, shell) => {
              const row = controller?.listing?.sessions.find((item) => item.id === selection.id)
              if (!row) throw new Error('这条会话不在当前列表里')
              await resumeInChat({ sessionFile: row.path })
              shell.reveal('pi-chat')
            },
            disabledReason: (_selection, shell) =>
              shell.enabled('pi-chat') ? null : '对话模块未在当前 profile 中启用',
          },
        ]
      : [],
    commands,
  }
}
