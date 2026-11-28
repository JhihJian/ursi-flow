import { useEffect, useRef, type ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { PiProvider, usePi } from './pi-context'
import { PiNavProvider, usePiNav } from './pi-nav'
import { configureApiBase } from './views/config/api/client'
import { PiSidebar } from './pi-sidebar'
import { PiWorkspace } from './pi-workspace'
import { PiStatus } from './pi-status'
import { ManagerProvider } from './views/config/module'
import { SessionsProvider, useSessionsController } from './views/sessions/sessions-context'
import { ChatProvider } from './views/chat/chat-context'

/**
 * Pi Web：一个模块、一个侧栏、两种页面（会话、配置）。
 *
 * home 在 PiProvider，页面与目录在 PiNav；chat 与 sessions 的控制器读它们，不各存一份。
 * 实体、状态机与接口契约见 docs/design/pi-web/OVERVIEW.md。
 */

export interface PiModuleOptions {
  /** 接口前缀；合并后的服务同源，默认空前缀。 */
  apiBaseUrl?: string
  /** localStorage 键前缀。 */
  storageKey?: string
}

/**
 * home 一变：会话列表的默认根换成它的 sessions/，当前目录清空（别的 home 下的目录对这里没有意义），
 * 页面离开会话页。只在 home 变化的那一刻动，之后根与目录是用户的事。
 */
function FollowHome() {
  const { homePath, sessionsRoot } = usePi()
  const { setRoot } = useSessionsController()
  const { setCwd } = usePiNav()
  const lastHome = useRef(homePath)

  useEffect(() => {
    if (!sessionsRoot || lastHome.current === homePath) return
    lastHome.current = homePath
    setRoot(sessionsRoot)
    setCwd(null)
  }, [homePath, sessionsRoot, setRoot, setCwd])

  return null
}

/** ChatProvider 要读 home 与当前会话，它们在 PiProvider 与 PiNav 里。 */
function ChatLayer({ children, apiBaseUrl }: { children: ReactNode; apiBaseUrl: string }) {
  const { homePath } = usePi()
  const { page, cwd, toSession } = usePiNav()
  return (
    <ChatProvider
      options={{
        managerApiBaseUrl: apiBaseUrl,
        home: homePath,
        sessionId: page.kind === 'session' ? page.id : null,
        cwd,
        // createChat 的响应就带 sessionId，页面原地填上它，不换页。
        onChatCreated: (chat) => toSession(chat.sessionId),
      }}
    >
      {children}
    </ChatProvider>
  )
}

/**
 * 会话列表的 Provider。删除会话后页面正指着它就回空会话页，
 * 所以这层要读 PiNav：放在 PiNavProvider 之内。
 */
function SessionsLayer({
  apiBaseUrl,
  storageKey,
  children,
}: {
  apiBaseUrl: string
  storageKey: string
  children: ReactNode
}) {
  const { page, toDraft } = usePiNav()
  return (
    <SessionsProvider
      options={{
        apiBaseUrl,
        storageKey: `${storageKey}.sessions`,
        onDeleted: (sessionId) => {
          if (page.kind === 'session' && page.id === sessionId) toDraft()
        },
      }}
    >
      {children}
    </SessionsProvider>
  )
}

export function createPiModule(options: PiModuleOptions = {}): WorkspaceModule {
  const apiBaseUrl = options.apiBaseUrl ?? ''
  const storageKey = options.storageKey ?? 'ursi.pi'

  const Provider = ({ children }: { children: ReactNode }) => (
    <PiProvider apiBaseUrl={apiBaseUrl} onApiBase={configureApiBase}>
      <PiNavProvider>
        <ManagerProvider storageKey={`${storageKey}.config`}>
          <SessionsLayer apiBaseUrl={apiBaseUrl} storageKey={storageKey}>
            <FollowHome />
            <ChatLayer apiBaseUrl={apiBaseUrl}>{children}</ChatLayer>
          </SessionsLayer>
        </ManagerProvider>
      </PiNavProvider>
    </PiProvider>
  )

  return {
    id: 'pi',
    title: 'Pi',
    Provider,
    Sidebar: PiSidebar,
    Workspace: PiWorkspace,
    context: {
      // 一个模块只能声明一种 kind，而这里多种实体并存；状态栏改用组件。
      Status: PiStatus,
    },
    keepMounted: true,
    minSidebarSize: 340,
    collapsedSidebarSize: 32,
  }
}
