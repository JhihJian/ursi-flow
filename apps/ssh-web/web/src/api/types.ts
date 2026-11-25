export type AuthType = 'password' | 'key'

export interface Connection {
  id: number
  name: string
  host: string
  port: number
  username: string
  auth_type: AuthType
  key_path: string | null
  key_passphrase: string | null
  created_at: string
  updated_at: string
}

/** 编辑表单提交值；password 空串表示保持原密码。 */
export interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string
  auth_type: AuthType
  password: string
  key_path: string
  key_passphrase: string
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
