import { create } from 'zustand'
import {
  closeConnection as apiCloseConnection,
  deleteDnsCacheEntry as apiDeleteDnsCacheEntry,
  flushDnsCache as apiFlushDnsCache,
  getConnections,
  getDnsCache,
  getDnsLog,
  getDnsRules,
  getFlows,
  getMemoryHistory,
  getOutbounds,
  getRules,
  getRuntime,
  getTrafficHistory,
  getVersion,
  traceRouting,
} from '@/api/client'
import type {
  ConnectionView,
  ConnectionsSnapshot,
  DnsCacheEntry,
  DnsLogRecord,
  DnsRuleList,
  FlowSummary,
  LogRecord,
  MemoryHistory,
  OutboundsSnapshot,
  RoutingTrace,
  RuntimeSnapshot,
  Section,
  TrafficHistory,
  TrafficRule,
  VersionInfo,
} from '@/api/types'
import {
  applyConfig,
  checkConfig,
  getConfig,
  restoreConfig,
  type ConfigCheckResult,
  type ConfigDiagnostic,
  type ConfigSnapshot,
} from '@/api/console'
import { errorMessage } from '@/lib/ui'
import { splitEndpoint } from '@/lib/format'

/** 连接列表按网络层附加标记，表格和详情共用同一个形状。 */
export type NetworkConnection = ConnectionView & { network: 'tcp' | 'udp' }

export type SelectedEntry =
  | { kind: 'connection'; item: NetworkConnection }
  | { kind: 'flow'; item: FlowSummary }

interface DaeState {
  section: Section
  /** 本连接能否读写 dae 配置文件（服务端按来源判定）。 */
  consoleAllowed: boolean
  paused: boolean
  tickSeconds: number
  loading: boolean
  error: string | null
  updatedAt: number | null

  version: VersionInfo | null
  runtime: RuntimeSnapshot | null
  outbounds: OutboundsSnapshot | null
  traffic: TrafficHistory | null
  memory: MemoryHistory | null
  connections: NetworkConnection[]
  connectionsMeta: ConnectionsSnapshot | null
  flows: FlowSummary[]
  rules: TrafficRule[]
  ruleGeneration: string | null
  dnsRules: DnsRuleList | null
  dnsLog: DnsLogRecord[]
  dnsLogTotal: number
  dnsCache: DnsCacheEntry[]
  dnsCacheTotal: number
  logs: LogRecord[]
  logLevel: string

  selected: SelectedEntry | null
  trace: RoutingTrace | null
  tracePending: boolean
  traceError: string | null

  config: ConfigSnapshot | null
  configDraft: string
  configDirty: boolean
  configDiagnostics: ConfigDiagnostic[]
  configCheckedAt: string | null
  configNotice: { kind: 'ok' | 'error'; message: string } | null
  configBusy: boolean

  setSection: (section: Section) => void
  togglePaused: () => void
  setTickSeconds: (seconds: number) => void
  setLogLevel: (level: string) => void
  refresh: () => Promise<void>
  bootstrap: () => Promise<void>
  select: (entry: SelectedEntry | null) => void
  runTrace: () => Promise<void>
  closeSelectedConnection: () => Promise<void>
  removeCacheEntry: (entryId: string) => Promise<void>
  flushCache: () => Promise<void>
  appendLog: (record: LogRecord) => void
  clearLogs: () => void
  loadConfig: () => Promise<void>
  setConfigDraft: (text: string) => void
  resetConfigDraft: () => void
  checkDraft: () => Promise<void>
  saveDraft: (content: string) => Promise<boolean>
  revertToBackup: (name: string) => Promise<void>
}

const MAX_LOGS = 500

function mergeConnections(snapshot: ConnectionsSnapshot): NetworkConnection[] {
  return [
    ...snapshot.tcp.map((item) => ({ ...item, network: 'tcp' as const })),
    ...snapshot.udp.map((item) => ({ ...item, network: 'udp' as const })),
  ].sort((left, right) => {
    const leftTime = left.started_at ? new Date(left.started_at).getTime() : 0
    const rightTime = right.started_at ? new Date(right.started_at).getTime() : 0
    return rightTime - leftTime
  })
}

export const useDaeStore = create<DaeState>((set, get) => ({
  section: 'overview',
  consoleAllowed: false,
  paused: false,
  tickSeconds: 3,
  loading: false,
  error: null,
  updatedAt: null,

  version: null,
  runtime: null,
  outbounds: null,
  traffic: null,
  memory: null,
  connections: [],
  connectionsMeta: null,
  flows: [],
  rules: [],
  ruleGeneration: null,
  dnsRules: null,
  dnsLog: [],
  dnsLogTotal: 0,
  dnsCache: [],
  dnsCacheTotal: 0,
  logs: [],
  logLevel: 'info',

  selected: null,
  trace: null,
  tracePending: false,
  traceError: null,

  config: null,
  configDraft: '',
  configDirty: false,
  configDiagnostics: [],
  configCheckedAt: null,
  configNotice: null,
  configBusy: false,

  setSection: (section) => {
    set({ section, selected: null, trace: null, traceError: null })
    void get().refresh()
  },
  togglePaused: () => set((state) => ({ paused: !state.paused })),
  setTickSeconds: (seconds) => set({ tickSeconds: seconds }),
  setLogLevel: (level) => set({ logLevel: level, logs: [] }),

  bootstrap: async () => {
    set({ loading: true })
    try {
      const health = await fetch('/healthz')
        .then((response) => response.json() as Promise<{ console?: boolean }>)
        .catch(() => ({ console: false }))
      set({ consoleAllowed: health.console === true })
      const [version, runtime, outbounds, traffic, memory] = await Promise.all([
        getVersion(),
        getRuntime(),
        getOutbounds(),
        getTrafficHistory(),
        getMemoryHistory(),
      ])
      set({ version, runtime, outbounds, traffic, memory, error: null, updatedAt: Date.now() })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ loading: false })
    }
    await get().refresh()
  },

  refresh: async () => {
    const { section } = get()
    set({ loading: true })
    try {
      switch (section) {
        case 'overview': {
          const [runtime, outbounds, traffic, memory, connections, rules] = await Promise.all([
            getRuntime(),
            getOutbounds(),
            getTrafficHistory(),
            getMemoryHistory(),
            getConnections({ windowSeconds: 60 }),
            getRules(),
          ])
          set({
            runtime,
            outbounds,
            traffic,
            memory,
            connections: mergeConnections(connections),
            connectionsMeta: connections,
            rules: rules.rules,
            ruleGeneration: rules.generation_id,
          })
          break
        }
        case 'connections': {
          const [runtime, outbounds, connections] = await Promise.all([
            getRuntime(),
            getOutbounds(),
            getConnections({ windowSeconds: 60, sort: 'window_total' }),
          ])
          set({
            runtime,
            outbounds,
            connections: mergeConnections(connections),
            connectionsMeta: connections,
          })
          break
        }
        case 'flows': {
          const flows = await getFlows()
          set({ flows: flows.flows })
          break
        }
        case 'rules': {
          const [rules, dnsRules] = await Promise.all([getRules(), getDnsRules()])
          set({ rules: rules.rules, ruleGeneration: rules.generation_id, dnsRules })
          break
        }
        case 'dns': {
          const [log, cache] = await Promise.all([getDnsLog(), getDnsCache()])
          set({
            dnsLog: log.records,
            dnsLogTotal: log.total,
            dnsCache: cache.entries,
            dnsCacheTotal: cache.total,
          })
          break
        }
        case 'logs':
          // 日志由 SSE 推送，轮询只刷新运行态指标。
          break
        case 'config':
          // 首次进入时拉一次文件内容；已有草稿时不让轮询覆盖编辑。
          if (!get().config) await get().loadConfig()
          break
      }
      // 选中的条目在轮询后同步最新数值，详情面板不会停在旧快照上。
      const { selected, connections, flows } = get()
      if (selected?.kind === 'connection') {
        const latest = connections.find((item) => item.id === selected.item.id)
        if (latest) set({ selected: { kind: 'connection', item: latest } })
      } else if (selected?.kind === 'flow') {
        const latest = flows.find((item) => item.id === selected.item.id)
        if (latest) set({ selected: { kind: 'flow', item: latest } })
      }
      set({ error: null, updatedAt: Date.now() })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ loading: false })
    }
  },

  select: (entry) => set({ selected: entry, trace: null, traceError: null }),

  runTrace: async () => {
    const { selected } = get()
    if (!selected) return
    const source = selected.item
    const network: 'tcp' | 'udp' =
      selected.kind === 'connection'
        ? selected.item.network
        : selected.item.network === 'udp'
          ? 'udp'
          : 'tcp'
    const dst = selected.kind === 'connection' ? selected.item.dst : selected.item.input.dst
    const src = selected.kind === 'connection' ? selected.item.src : selected.item.input.src
    const domain =
      selected.kind === 'connection' ? selected.item.domain : selected.item.input.domain
    const pname = source.pname
    const { host: dstIp, port: dstPort } = splitEndpoint(dst)
    const { host: srcIp, port: srcPort } = splitEndpoint(src)
    if (!dstIp || !dstPort) {
      set({ traceError: '缺少目标地址，无法回溯' })
      return
    }
    set({ tracePending: true, traceError: null })
    try {
      const trace = await traceRouting({
        network,
        dstIp,
        dstPort,
        srcIp,
        srcPort,
        domain,
        pname,
      })
      set({ trace })
    } catch (error) {
      set({ traceError: errorMessage(error) })
    } finally {
      set({ tracePending: false })
    }
  },

  closeSelectedConnection: async () => {
    const { selected, refresh } = get()
    if (!selected || selected.kind !== 'connection') return
    await apiCloseConnection(selected.item.id)
    set({ selected: null, trace: null })
    await refresh()
  },

  removeCacheEntry: async (entryId) => {
    await apiDeleteDnsCacheEntry(entryId)
    await get().refresh()
  },

  flushCache: async () => {
    await apiFlushDnsCache()
    await get().refresh()
  },

  appendLog: (record) =>
    set((state) => ({ logs: [...state.logs, record].slice(-MAX_LOGS) })),
  clearLogs: () => set({ logs: [] }),

  loadConfig: async () => {
    set({ configBusy: true })
    try {
      const snapshot = await getConfig()
      set({
        config: snapshot,
        configDraft: snapshot.content,
        configDirty: false,
        configDiagnostics: [],
        configCheckedAt: null,
        configNotice: null,
      })
    } catch (error) {
      set({ configNotice: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ configBusy: false })
    }
  },

  setConfigDraft: (text) =>
    set((state) => ({
      configDraft: text,
      configDirty: state.config ? text !== state.config.content : false,
      configNotice: null,
    })),

  resetConfigDraft: () =>
    set((state) => ({
      configDraft: state.config?.content ?? '',
      configDirty: false,
      configDiagnostics: [],
      configCheckedAt: null,
      configNotice: null,
    })),

  checkDraft: async () => {
    set({ configBusy: true, configNotice: null })
    try {
      const { configDraft } = get()
      const result: ConfigCheckResult = await checkConfig(configDraft)
      set({
        configDiagnostics: result.diagnostics,
        configCheckedAt: result.validated_at,
        configNotice: {
          kind: result.valid ? 'ok' : 'error',
          message: result.valid
            ? '校验通过'
            : `校验未通过，共 ${result.diagnostics.length} 条问题`,
        },
      })
    } catch (error) {
      set({ configNotice: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ configBusy: false })
    }
  },

  saveDraft: async (content) => {
    set({ configBusy: true, configNotice: null })
    try {
      const snapshot = get().config
      const result = await applyConfig(content, snapshot?.sha256 ?? null)
      const refreshed = await getConfig()
      set({
        config: refreshed,
        configDraft: refreshed.content,
        configDirty: false,
        configDiagnostics: [],
        configCheckedAt: null,
        configNotice: {
          kind: 'ok',
          message: `已生效，generation ${result.generationId ?? '-'}，备份 ${result.backup}`,
        },
      })
      return true
    } catch (error) {
      set({ configNotice: { kind: 'error', message: errorMessage(error) } })
      return false
    } finally {
      set({ configBusy: false })
    }
  },

  revertToBackup: async (name) => {
    set({ configBusy: true, configNotice: null })
    try {
      const result = await restoreConfig(name)
      const refreshed = await getConfig()
      set({
        config: refreshed,
        configDraft: refreshed.content,
        configDirty: false,
        configDiagnostics: [],
        configCheckedAt: null,
        configNotice: {
          kind: 'ok',
          message: `已回滚到 ${result.backup}，generation ${result.generationId ?? '-'}`,
        },
      })
    } catch (error) {
      set({ configNotice: { kind: 'error', message: errorMessage(error) } })
    } finally {
      set({ configBusy: false })
    }
  },
}))

/** 供 SSE 回调使用的稳定引用，避免订阅整个 store。 */
export const daeActions = {
  appendLog: (record: LogRecord) => useDaeStore.getState().appendLog(record),
}
