/** 一条 SSH 连接配置：名称 + ssh 命令。 */
export interface Connection {
  id: number
  name: string
  command: string
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

/** 一次远端设备资源采样。CPU 取 1 分钟负载，内存已用 = MemTotal - MemAvailable。 */
export interface HostMetrics {
  hostname: string
  cores: number
  load1: number
  mem_total_kb: number
  mem_available_kb: number
  /** ssh 通道往返耗时（毫秒，一位小数）；未收到 pong 时为 null。 */
  latency_ms: number | null
  sampled_at: string
}
