import { useEffect, useRef, type ReactNode } from 'react'
import type { WorkspaceModule } from '@ursi/workspace-shell'
import { PiProvider, usePi } from './pi-context'
import { PiSidebar } from './pi-sidebar'
import { PiWorkspace } from './pi-workspace'
import { PiStatus } from './pi-status'
import { createPiManagerModule } from './views/config/module'
import { createPiSessionsModule } from './views/sessions/module'
import { useSessionsController } from './views/sessions/sessions-context'
import { createPiChatModule } from './views/chat/module'
import { useChatController } from './views/chat/chat-context'
import { useAppStore } from './views/config/store/app-store'
import { bridges } from './bridges'
import type { LiveSessionFeed } from './views/sessions/live'

/**
 * Pi Web：一个工作区模块、三个视图。
 *
 * 三个视图只操作同一套领域模型：`PiProvider` 持当前 home 与视图，视图各自的
 * store 保留一份渲染镜像。实体、状态机与接口契约见 docs/design/pi-web/OVERVIEW.md。
 */

function Passthrough({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export interface PiModuleOptions {
  /** 接口前缀；合并后的服务同源，默认空前缀。 */
  apiBaseUrl?: string
  /** localStorage 键前缀。 */
  storageKey?: string
}

/** 运行态来源：外部进程心跳已经合流进会话实体。 */
function createLiveFeed(base: string): () => Promise<LiveSessionFeed> {
  return async () => {
  const response = await fetch(`${base}/api/sessions?state=live`)
  const payload = (await response.json()) as {
    heartbeatDetected?: boolean
    sessions?: Array<{
      id: string
      filePath: string | null
      parentFile: string | null
      cwd: string
      title: string | null
      model: { provider: string; modelId: string } | null
      runtimes: Array<{ origin: 'local' | 'process'; host: string; pid: number; status: 'idle' | 'running'; updatedAt: number }>
      stateSince: number
      seenAt: number
    }>
  }
  const now = Date.now()
  return {
    sessions: (payload.sessions ?? []).flatMap((session) =>
      session.runtimes.map((fact) => ({
        sessionId: session.id,
        sessionFile: session.filePath,
        parentSessionFile: session.parentFile,
        cwd: session.cwd,
        name: session.title,
        model: session.model ? `${session.model.provider}/${session.model.modelId}` : null,
        mode: 'chat',
        status: fact.status,
        host: fact.host,
        sameHost: fact.origin === 'local' || fact.host === '',
        pid: fact.pid,
        startedAt: session.stateSince,
        updatedAt: Math.max(fact.updatedAt, session.seenAt, now - 60_000),
      })),
    ),
    stale: 0,
    warnings: [],
    heartbeatDetected: payload.heartbeatDetected === true,
    now,
  }
  }
}

/**
 * 视图之间的跳转是模块内切换，不再经过外壳的 actions：
 * 「看完整轨迹」= 切到会话视图并选中同一份会话文件，
 * 「在对话里继续」= 切到对话视图并在同一实体上续聊。
 */
function WireBridges() {
  const { setView } = usePi()
  const sessions = useSessionsController()
  const chat = useChatController()

  useEffect(() => {
    bridges.setView = setView
    bridges.openSessionInSessions = async (target) => {
      sessions.openSession(target)
      setView('sessions')
    }
    bridges.resumeInChat = async (sessionFile) => {
      const resumed = await chat.resume(sessionFile)
      if (!resumed) throw new Error('续聊失败：服务端没有返回会话')
      setView('chat')
    }
  }, [setView, sessions, chat])

  return null
}

/** 配置视图的 home 选择：store 是它的渲染镜像，PiProvider 是真源。 */
function ConfigBridge() {
  const { homePath, setHomePath } = usePi()
  const storeHome = useAppStore((state) => state.homePath)
  const confirmHome = useAppStore((state) => state.confirmHome)

  useEffect(() => {
    if (homePath && homePath !== storeHome) void confirmHome(homePath)
  }, [homePath, storeHome, confirmHome])

  useEffect(() => {
    if (storeHome && storeHome !== homePath) setHomePath(storeHome)
  }, [storeHome, homePath, setHomePath])

  return null
}

/** 对话视图的 home 选择：与配置视图同向同步。 */
function ChatBridge() {
  const { homePath, setHomePath } = usePi()
  const { home, setHome } = useChatController()

  useEffect(() => {
    if (homePath && homePath !== home) setHome(homePath)
  }, [homePath, home, setHome])

  useEffect(() => {
    if (home && home !== homePath) setHomePath(home)
  }, [home, homePath, setHomePath])

  return null
}

/**
 * home 决定会话列表的默认根：home 一变就把根设成它的 sessions/。
 * 只在 home 变化的那一刻动，之后根是用户的事：用户切成任意外部目录不会被拉回来。
 */
function SessionsBridge() {
  const { homePath, sessionsRoot } = usePi()
  const { setRoot } = useSessionsController()
  const lastHome = useRef(homePath)

  useEffect(() => {
    if (!sessionsRoot || lastHome.current === homePath) return
    lastHome.current = homePath
    setRoot(sessionsRoot)
  }, [homePath, sessionsRoot, setRoot])

  return null
}

export function createPiModule(options: PiModuleOptions = {}): WorkspaceModule {
  const apiBaseUrl = options.apiBaseUrl ?? ''
  const storageKey = options.storageKey ?? 'ursi.pi'

  // 三个视图工厂只建一次：组件引用稳定，宿主重渲染不会重挂内部状态。
  const config = createPiManagerModule({
    apiBaseUrl,
    storageKey: `${storageKey}.config`,
  })
  const sessions = createPiSessionsModule({
    apiBaseUrl,
    storageKey: `${storageKey}.sessions`,
    liveSessions: { fetch: createLiveFeed(apiBaseUrl) },
    resumeSessionInChat: (input) => bridges.resumeInChat(input.sessionFile),
  })
  const chat = createPiChatModule({
    managerApiBaseUrl: apiBaseUrl,
    storageKey: `${storageKey}.chat`,
    openSessionInSessions: (target) => bridges.openSessionInSessions(target),
  })

  const ConfigProvider = config.Provider ?? Passthrough
  const SessionsProvider = sessions.Provider ?? Passthrough
  const ChatProvider = chat.Provider ?? Passthrough

  const Provider = ({ children }: { children: ReactNode }) => (
    <PiProvider apiBaseUrl={apiBaseUrl}>
      <ConfigProvider>
        <ConfigBridge />
        <SessionsProvider>
          <SessionsBridge />
          <ChatProvider>
            <ChatBridge />
            <WireBridges />
            {children}
          </ChatProvider>
        </SessionsProvider>
      </ConfigProvider>
    </PiProvider>
  )

  return {
    id: 'pi',
    title: 'Pi',
    Provider,
    Sidebar: (props) => (
      <PiSidebar {...props} config={config} sessions={sessions} chat={chat} />
    ),
    Workspace: () => <PiWorkspace config={config} sessions={sessions} chat={chat} />,
    context: {
      // 一个模块只能声明一种 kind，而这里三种实体并存；状态栏改用组件。
      Status: PiStatus,
    },
    keepMounted: true,
    minSidebarSize: 340,
    collapsedSidebarSize: 32,
  }
}
