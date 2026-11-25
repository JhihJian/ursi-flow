/** dae native API v1 的只读视图。字段名与 dae 返回保持一致，缺省的字节数用十进制字符串。 */

export interface VersionInfo {
  api: { name: string; major: number; status: string }
  engine: { name: string; version: string }
  build: { revision: string; target: string; built_at: string }
}

export interface RuntimeSnapshot {
  observed_at: string
  instance_id: string
  lifecycle: { state: string; started_at: string; uptime_seconds: string }
  generation: { active_id: string; config_revision: string; state: string; activated_at: string }
  datapath: Datapath
  traffic: {
    scope: string
    observed_by: string
    counter_since: string
    sampled_at: string
    connections: { tcp: number; udp: number; total: number }
    bytes: { upload: string; download: string }
    rates: { window_seconds: number; upload_bytes_per_second: string; download_bytes_per_second: string }
  }
  process: { cpu_percent: number }
  last_reload: string | null
}

export interface Datapath {
  observed_at: string
  kind: string
  state: string
  visibility: string
  ebpf: {
    backend: string
    programs: string
    hooks: string
    routing: { state: string; generation_id: string; epoch: string }
    health: string
    last_error: string | null
  } | null
  errors: Array<{ code?: string; message?: string }>
}

export interface OutboundCounters {
  name: string
  kind: string
  active_connections: number
  total_connections: string
  upload_bytes: string
  download_bytes: string
  errors: string
}

export interface OutboundsSnapshot {
  observed_at: string
  counter_since: string
  outbounds: OutboundCounters[]
}

export interface TrafficSample {
  sampled_at: string
  upload_bytes_per_second: string
  download_bytes_per_second: string
  connections: number | null
}

export interface TrafficHistory {
  observed_at: string
  window_seconds: number
  sampled_every_seconds: number
  samples: TrafficSample[]
}

export interface MemorySample {
  sampled_at: string
  rss_bytes: string
  cgroup_current_bytes: string | null
  kernel_ebpf_bytes: string | null
}

export interface MemoryHistory {
  observed_at: string
  window_seconds: number
  samples: MemorySample[]
}

export interface ConnectionView {
  id: string
  flow_id: string | null
  pname: string | null
  state: string
  src: string
  dst: string
  domain: string | null
  outbound: string | null
  chain: string[]
  chain_source: string
  rule_id: string | null
  rule_expression: string | null
  rule_source: string
  ingress: string | null
  domain_source: string | null
  started_at: string | null
  observed_by: string
  upload_bytes: string | null
  download_bytes: string | null
  upload_bytes_per_second: string | null
  download_bytes_per_second: string | null
  upload_window_bytes: string | null
  download_window_bytes: string | null
}

export interface ConnectionsSnapshot {
  observed_at: string
  instance_id: string
  visibility: string
  truncated: boolean
  window: { seconds: number } | null
  tcp: ConnectionView[]
  udp: ConnectionView[]
  total_tcp: number
  total_udp: number
}

export interface FlowInput {
  src: string | null
  dst: string | null
  domain: string | null
  domain_source: string | null
  pid: number | null
  process_path: string | null
  ingress: string | null
  domain_rule_ids: string[]
}

export interface FlowSummary {
  id: string
  network: string
  state: string
  pname: string | null
  connection_id: string | null
  outbound: string | null
  chain: string[]
  chain_source: string
  rule_id: string | null
  rule_expression: string | null
  rule_source: string
  ingress: string | null
  observed_by: string
  started_at: string | null
  ended_at: string | null
  input: FlowInput
}

export interface FlowList {
  instance_id: string
  observed_at: string
  flows: FlowSummary[]
  next_cursor: string | null
}

export interface RuleSource {
  file: string | null
  line: number | null
}

export interface TrafficRule {
  rule_id: string
  index: number
  expression: string
  outbound: string
  source: RuleSource | null
  kind: string
}

export interface RuleList {
  generation_id: string
  rules: TrafficRule[]
}

export interface DnsRoutingRule {
  rule_id: string
  index: number
  expression: string
  action: string
  upstream: string | null
  source: RuleSource | null
  kind: string
}

export interface DnsRuleList {
  generation_id: string
  request: DnsRoutingRule[]
  response: DnsRoutingRule[]
}

export interface DnsAnswer {
  name: string
  type: string
  class: string
  ttl: number
  data: string
}

export interface DnsLogRecord {
  id: string
  observed_at: string
  src: string | null
  question: { name: string; type: string }
  status: string
  cached: boolean
  upstream: string | null
  route: { source: string; rule: string | null }
  elapsed_ms: number
  answers: DnsAnswer[]
}

export interface DnsLogList {
  observed_at: string
  total: number
  next_cursor: string | null
  records: DnsLogRecord[]
}

export interface DnsCacheEntry {
  entry_id: string
  domain: string
  type: string
  class: string
  status: string
  answers?: DnsAnswer[]
  expires_at: string
  stale_until: string | null
}

export interface DnsCacheList {
  observed_at: string
  coverage: { positive: boolean; negative: boolean; persistent: boolean }
  entries: DnsCacheEntry[]
  total: number
  next_cursor: string | null
}

export interface RoutingTraceCondition {
  id: string
  expression: string
  result: string
  missing_inputs: string[]
}

export interface RoutingTraceRule {
  rule_id: string
  expression: string | null
  result: string
  missing_inputs: string[]
  conditions: RoutingTraceCondition[]
}

export interface RoutingTraceEvaluation {
  dst_ip: string | null
  decision: string
  outbound: string | null
  missing_inputs: string[]
  rules: RoutingTraceRule[]
}

export interface RoutingTrace {
  mode: string
  instance_id: string
  generation_id: string
  observed_at: string
  evaluations: RoutingTraceEvaluation[]
  dns: unknown[]
}

export interface LogRecord {
  ts: string
  level: string
  target: string | null
  message: string
  fields: Record<string, unknown> | null
}

export type Section = 'overview' | 'connections' | 'flows' | 'rules' | 'dns' | 'logs' | 'config'
