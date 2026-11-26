import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  FlowClient,
  FlowConfig,
  FlowDetail,
  FlowSummary,
  RunSummary,
  RunView,
} from './api'
import { buildVariables, initialVariables, type VariableDraft } from './lib/flow'

/** 运行还没结束时按这个间隔刷新；只在有进行中的运行时才开启轮询。 */
const POLL_INTERVAL = 900

export interface FlowStoreValue {
  config?: FlowConfig
  flows: FlowSummary[]
  flowId: string | null
  detail?: FlowDetail
  draft: VariableDraft
  runs: RunSummary[]
  runId: string | null
  run?: RunView
  busy: string | null
  error: string | null
  clearError: () => void
  refresh: () => Promise<void>
  saveHome: (path: string) => Promise<void>
  selectFlow: (id: string) => Promise<void>
  setDraft: (name: string, value: string) => void
  start: () => Promise<void>
  selectRun: (runId: string | null) => Promise<void>
  refreshRuns: () => Promise<void>
  confirm: (result: string) => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
}

const FlowStore = createContext<FlowStoreValue | null>(null)

export function useFlowStore(): FlowStoreValue
export function useFlowStore<T>(selector: (value: FlowStoreValue) => T): T
export function useFlowStore<T>(
  selector?: (value: FlowStoreValue) => T,
): FlowStoreValue | T {
  const value = useContext(FlowStore)
  if (value === null) throw new Error('flow 模块必须挂在 FlowProvider 内')
  return selector === undefined ? value : selector(value)
}

export function FlowProvider({
  client,
  children,
}: {
  client: FlowClient
  children: ReactNode
}) {
  const [config, setConfig] = useState<FlowConfig>()
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [flowId, setFlowId] = useState<string | null>(null)
  const [detail, setDetail] = useState<FlowDetail>()
  const [draft, setDraftState] = useState<VariableDraft>({})
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunView>()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const detailRequest = useRef(0)

  const loadDetail = useCallback(
    async (id: string) => {
      const request = detailRequest.current + 1
      detailRequest.current = request
      const flow = await client.getFlow(id)
      if (detailRequest.current !== request) return
      setDetail(flow)
      setDraftState(initialVariables(flow))
    },
    [client],
  )

  const refreshRuns = useCallback(async () => {
    setRuns(await client.listRuns())
  }, [client])

  const refresh = useCallback(async () => {
    setBusy('refresh')
    try {
      const [nextConfig, listed] = await Promise.all([
        client.getConfig(),
        client.listFlows(),
      ])
      setConfig(nextConfig)
      setFlows(listed.flows)
      setError(null)
      const current = flowId ?? listed.flows.find((flow) => flow.valid)?.id ?? null
      if (current !== null && current !== flowId) {
        setFlowId(current)
        await loadDetail(current)
      }
      await refreshRuns()
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(null)
    }
  }, [client, flowId, loadDetail, refreshRuns])

  // 只在模块挂载时拉一次：列表与配置不动，运行数据由用户操作触发刷新。
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveHome = useCallback(
    async (path: string) => {
      setBusy('save-home')
      try {
        const nextConfig = await client.setFlowHome(path)
        setConfig(nextConfig)
        const listed = await client.listFlows()
        setFlows(listed.flows)
        const first = listed.flows.find((flow) => flow.valid)?.id ?? null
        setFlowId(first)
        setRunId(null)
        setRun(undefined)
        if (first !== null) await loadDetail(first)
        else setDetail(undefined)
        await refreshRuns()
        setError(null)
      } catch (problem) {
        setError(messageOf(problem))
      } finally {
        setBusy(null)
      }
    },
    [client, loadDetail, refreshRuns],
  )

  const selectFlow = useCallback(
    async (id: string) => {
      setFlowId(id)
      setRunId(null)
      setRun(undefined)
      setBusy('flow')
      try {
        await loadDetail(id)
        setError(null)
      } catch (problem) {
        setError(messageOf(problem))
      } finally {
        setBusy(null)
      }
    },
    [loadDetail],
  )

  const setDraft = useCallback((name: string, value: string) => {
    setDraftState((current) => ({ ...current, [name]: value }))
  }, [])

  const start = useCallback(async () => {
    if (flowId === null) return
    setBusy('start')
    try {
      if (detail === undefined) throw new Error('还没有选中 Flow')
      const variables = buildVariables(detail, draft)
      const started = await client.startRun({ flowId, variables })
      setRunId(started.runId)
      await refreshRuns()
      setRun(await client.getRun(started.runId))
      setError(null)
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(null)
    }
  }, [client, detail, draft, flowId, refreshRuns])

  const selectRun = useCallback(
    async (id: string | null) => {
      setRunId(id)
      if (id === null) {
        setRun(undefined)
        return
      }
      setBusy('run')
      try {
        const view = await client.getRun(id)
        setRun(view)
        if (view.flowId !== '' && view.flowId !== flowId) {
          setFlowId(view.flowId)
          await loadDetail(view.flowId)
        }
        setError(null)
      } catch (problem) {
        setError(messageOf(problem))
      } finally {
        setBusy(null)
      }
    },
    [client, flowId, loadDetail],
  )

  const confirm = useCallback(
    async (result: string) => {
      if (run?.pending === undefined) return
      setBusy('confirm')
      try {
        setRun(await client.confirm(run.runId, run.pending.stepId, result))
        await refreshRuns()
        setError(null)
      } catch (problem) {
        setError(messageOf(problem))
      } finally {
        setBusy(null)
      }
    },
    [client, refreshRuns, run],
  )

  const resume = useCallback(async () => {
    if (run === undefined) return
    setBusy('resume')
    try {
      setRun(await client.resume(run.runId))
      await refreshRuns()
      setError(null)
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(null)
    }
  }, [client, refreshRuns, run])

  const stop = useCallback(async () => {
    if (run === undefined) return
    setBusy('stop')
    try {
      setRun(await client.stopRun(run.runId, '从工作台停止'))
      await refreshRuns()
      setError(null)
    } catch (problem) {
      setError(messageOf(problem))
    } finally {
      setBusy(null)
    }
  }, [client, refreshRuns, run])

  // 只轮询自己打开的、还在跑的那次运行；离开后自动停止。
  useEffect(() => {
    if (run?.active !== true) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          setRun(await client.getRun(run.runId))
          await refreshRuns()
        } catch {
          // 轮询失败保留上一份视图，下次再试；错误不打断正在看的运行。
        }
      })()
    }, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [client, refreshRuns, run?.active, run?.runId])

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<FlowStoreValue>(
    () => ({
      config,
      flows,
      flowId,
      detail,
      draft,
      runs,
      runId,
      run,
      busy,
      error,
      clearError,
      refresh,
      saveHome,
      selectFlow,
      setDraft,
      start,
      selectRun,
      refreshRuns,
      confirm,
      resume,
      stop,
    }),
    [
      busy,
      clearError,
      config,
      confirm,
      detail,
      draft,
      error,
      flowId,
      flows,
      refresh,
      refreshRuns,
      resume,
      run,
      runId,
      runs,
      saveHome,
      selectFlow,
      selectRun,
      setDraft,
      start,
      stop,
    ],
  )

  return <FlowStore.Provider value={value}>{children}</FlowStore.Provider>
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
