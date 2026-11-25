/** 一条连接配置。kind 为 local 时是虚拟本机连接（服务所在设备）。 */
export interface Connection {
  id: number
  name: string
  command: string
  kind: 'local' | 'ssh'
  created_at: string
  updated_at: string
}

/** 连接表单提交值。 */
export interface ConnectionInput {
  name: string
  command: string
}

/** 远端一条 tmux 会话。 */
export interface TmuxSession {
  name: string
  attached: number
  created: number
}

/** tmux-sessions 响应：sessions 为 null 表示远端没有 tmux。 */
export interface TmuxSessionsResponse {
  sessions: TmuxSession[] | null
}

/** WS 控制帧（前端 → 服务端）。 */
export type ControlFrame = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }

/** WS 事件帧（服务端 → 前端）。 */
export type EventFrame = { type: 'error'; message: string } | { type: 'closed'; message: string }
