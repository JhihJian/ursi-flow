import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { SidebarFrame, useOptionalWorkspace, type WorkspaceModule } from '@ursi/workspace-shell'
import { ChatProvider, useChatController, type ChatController, type ChatControllerOptions } from './chat-context'

/** 本模块对外发布的选中类型：一场 pi 对话。 */
export const PI_CHAT_KIND = 'pi.chat'

/**
 * 轨迹组件库单文件约 1MB，只在工作区需要时加载；
 * 侧边栏与首屏不背这份依赖。
 */
const ChatWorkspaceLazy = lazy(() =>
  import('./components/ChatWorkspace').then((module) => ({ default: module.ChatWorkspace })),
)
const ChatSidebarLazy = lazy(() =>
  import('./components/ChatSidebar').then((module) => ({ default: module.ChatSidebar })),
)

function WorkspaceFallback() {
  return (
    <div className="pichat">
      <div className="pichat-empty">加载对话视图…</div>
    </div>
  )
}

/** 把模块内的选中同步到外壳；清空时只清除属于本模块的选中。 */
function SelectionBridge() {
  const { active } = useChatController()
  const workspace = useOptionalWorkspace()
  const select = workspace?.select
  const current = useRef(workspace?.selection ?? null)
  current.current = workspace?.selection ?? null

  useEffect(() => {
    if (!select) return
    if (active) {
      select({ kind: PI_CHAT_KIND, id: active.sessionId, label: active.name ?? active.sessionId.slice(0, 12) })
      return
    }
    if (current.current?.kind === PI_CHAT_KIND) select(null)
  }, [active, select])

  return null
}

/** 状态栏：当前对话的 home、模型与状态。 */
function ChatStatus() {
  const { active, home, chats } = useChatController()
  if (!active) {
    return (
      <span>
        Pi 对话 {chats.length > 0 ? `· ${chats.length} 场` : ''}
        {home ? ` · ${home}` : ''}
      </span>
    )
  }
  return (
    <span>
      {active.state === 'running' ? '运行中' : active.state === 'error' ? '出错' : '空闲'} ·{' '}
      {active.model ?? '默认模型'} · {active.home}
    </span>
  )
}

/** 跨模块能力：在对话里继续某条历史会话。 */
export interface PiChatCommands {
  resumeSession: (input: { sessionFile: string }) => Promise<{ id: string; label: string }>
}

export type PiChatModuleOptions = ChatControllerOptions

/**
 * pi 交互对话模块工厂。
 *
 * 运行时在管理台（SDK、home、凭据、限流都在那里），本模块只做界面；
 * 会话内容的渲染复用与会话模块同一份轨迹组件库。
 */
export function createPiChatModule(
  options: PiChatModuleOptions = {},
): WorkspaceModule & { commands: PiChatCommands } {
  let controller: ChatController | null = null

  function RegisterController({ current }: { current: ChatController }) {
    useEffect(() => {
      controller = current
      return () => {
        if (controller === current) controller = null
      }
    }, [current])
    return null
  }

  function ControllerBridge() {
    const current = useChatController()
    return <RegisterController current={current} />
  }

  const Provider = ({ children }: { children: ReactNode }) => (
    <ChatProvider options={options}>
      <ControllerBridge />
      <SelectionBridge />
      {children}
    </ChatProvider>
  )

  const Sidebar = ({ collapsed, collapse, expand }: { collapsed: boolean; collapse: () => void; expand: () => void }) => (
    <Suspense fallback={<SidebarFrame title="Pi 对话" collapsed={collapsed} collapse={collapse} expand={expand} items={[{ label: '状态', value: '加载中' }]} />}>
      <ChatSidebarLazy collapsed={collapsed} collapse={collapse} expand={expand} />
    </Suspense>
  )

  const Workspace = () => (
    <Suspense fallback={<WorkspaceFallback />}>
      <ChatWorkspaceLazy />
    </Suspense>
  )

  const commands: PiChatCommands = {
    async resumeSession({ sessionFile }) {
      if (!controller) throw new Error('对话模块未挂载')
      const target = sessionFile.trim()
      if (!target) throw new Error('会话文件不能为空')
      const chat = await controller.resume(target)
      if (!chat) throw new Error('续聊失败：管理台没有返回会话')
      return { id: chat.sessionId, label: chat.name ?? chat.sessionId.slice(0, 12) }
    },
  }

  return {
    id: 'pi-chat',
    title: 'Pi 对话',
    Provider,
    Sidebar,
    Workspace,
    context: {
      kind: PI_CHAT_KIND,
      summary: (selection) => selection.label ?? `对话 ${selection.id}`,
      Status: ChatStatus,
    },
    /**
     * 跳转必须走外壳的操作通道：工作区拿不到 ShellHandle，
     * 只有 actions 的 run 能 reveal 目标模块。
     */
    actions: options.openSessionInSessions
      ? [
          {
            id: 'open-chat-trajectory',
            label: '在会话模块打开完整轨迹',
            appliesTo: (selection) => selection?.kind === PI_CHAT_KIND,
            run: async (_selection, shell) => {
              if (!controller) throw new Error('对话模块未挂载')
              await controller.openTrajectory()
              shell.reveal('pi-sessions')
            },
            disabledReason: (_selection, shell) =>
              shell.enabled('pi-sessions')
                ? controller?.active?.sessionFile
                  ? null
                  : '这条路对话还没有会话文件'
                : '会话模块未在当前 profile 中启用',
          },
        ]
      : [],
    keepMounted: true,
    minSidebarSize: 320,
    collapsedSidebarSize: 32,
    commands,
  }
}
