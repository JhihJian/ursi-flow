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

/** 连接自检结果：ok 为 true 时 detail 是远端主机名，否则是失败原因。 */
export interface TestConnectionResponse {
  ok: boolean
  detail: string | null
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

/** 一条进程的内存占用（按 RSS 取前几）。 */
export interface ProcessUsage {
  pid: number
  name: string
  /** ps 给出的物理内存占比（%）。 */
  mem_percent: number
  rss_kb: number
}

/** 根分区用量。 */
export interface DiskUsage {
  total_kb: number
  used_kb: number
}

/** 一次远端设备资源采样。 */
export interface HostMetrics {
  hostname: string
  cores: number
  load1: number
  load5: number
  load15: number
  /** 两次 /proc/stat 间隔内的忙碌占比（%）；取不到内核计数时为 null。 */
  cpu_percent: number | null
  mem_total_kb: number
  mem_available_kb: number
  mem_free_kb: number
  swap_total_kb: number
  swap_free_kb: number
  disk: DiskUsage | null
  uptime_secs: number | null
  /** 所有非 lo 网卡的累计字节数，速率由两次采样差值算出。 */
  net_rx_bytes: number
  net_tx_bytes: number
  /** ssh 通道往返耗时（毫秒，一位小数）；未收到 pong 时为 null。 */
  latency_ms: number | null
  processes: ProcessUsage[]
  sampled_at: string
}
