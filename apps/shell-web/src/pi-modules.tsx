import type { WorkspaceModule, WorkspaceProfile } from '@ursi/workspace-shell'
import { createPiSessionsModule } from '@ursi/pi-sessions-web/module'
import { createPiChatModule, type PiChatCommands } from '@ursi/pi-chat-web/module'
import { createApiClient } from '@ursi/pi-manager-web/client'
import { createPiManagerModule } from '@ursi/pi-manager-web/module'
import '@ursi/pi-sessions-web/module.css'
import '@ursi/pi-chat-web/module.css'
import '@ursi/pi-manager-web/module.css'
// 轨迹组件库的样式是全局前缀类（dsw- / trajectory-*），在这里引一次，两个入口共用。
import 'pi-agent-trajectory-viewer/style.css'

/**
 * Pi 三件套的组合根：会话浏览、交互对话、配置管理。
 *
 * 单独放在这里，是为了让完整工作台（registry.tsx）与独立预览页（pi-main.tsx）
 * 共用同一份接线，避免预览页抄一份、日后漂移。
 *
 * 依赖方向：chat 依赖 manager；sessions 谁都不依赖，只接收注入的命令与运行态来源。
 */

/** 管理台的运行态来源：会话模块只认普通值，不 import 管理台模块。 */
const managerClient = createApiClient('/api/pi-manager')

/**
 * 会话与对话互为入口（「在对话里继续」与「完整轨迹」），两个工厂需要对方的命令。
 * 会话先建，对话后建；会话侧的这条边用延迟引用，避免相互构造。
 */
let chatModule: (WorkspaceModule & { commands: PiChatCommands }) | null = null

const sessionsModule = createPiSessionsModule({
  apiBaseUrl: '/api/pi-sessions',
  storageKey: 'ursi.sessions',
  liveSessions: { fetch: () => managerClient.getLiveFeed() },
  resumeSessionInChat: async ({ sessionFile }) => {
    if (!chatModule) throw new Error('对话模块未登记')
    return chatModule.commands.resumeSession({ sessionFile })
  },
})

chatModule = createPiChatModule({
  managerApiBaseUrl: '/api/pi-manager',
  storageKey: 'ursi.chat',
  openSessionInSessions: sessionsModule.commands.openSession,
})

const configModule = createPiManagerModule({
  apiBaseUrl: '/api/pi-manager',
  storageKey: 'ursi.pi-config',
  openRootInSessions: sessionsModule.commands.openRoot,
})

export const PI_MODULES: WorkspaceModule[] = [sessionsModule, chatModule, configModule]

/** 预览页只需要 Pi 自己的几个页面组合，不掺其它模块。 */
export const PI_PROFILES: WorkspaceProfile[] = [
  { id: 'pi', title: 'Pi 控制台', modules: ['pi-chat', 'pi-sessions', 'pi-config'] },
  { id: 'chat', title: '对话', modules: ['pi-chat'] },
  { id: 'sessions', title: '会话', modules: ['pi-sessions'] },
  { id: 'config', title: '配置', modules: ['pi-config'] },
]

/** 跨模块依赖的说明，Registry 页与本页共用同一份事实。 */
export const PI_WIRES: Array<{ from: string; to: string; capability: string }> = [
  {
    from: 'pi-chat',
    to: 'pi-sessions',
    capability: 'openSessionInSessions → pi-sessions.commands.openSession',
  },
  {
    from: 'pi-sessions',
    to: 'pi-chat',
    capability: 'resumeSessionInChat → pi-chat.commands.resumeSession（延迟引用）',
  },
  {
    from: 'pi-sessions',
    to: 'pi-manager',
    capability: 'liveSessions.fetch → /api/pi-manager 的会话运行态',
  },
  {
    from: 'pi-config',
    to: 'pi-sessions',
    capability: 'openRootInSessions → pi-sessions.commands.openRoot',
  },
]
