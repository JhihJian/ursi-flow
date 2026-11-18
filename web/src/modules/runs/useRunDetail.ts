import { useCallback, useEffect, useReducer, useRef } from 'react'

import { api } from '@/shared/api'
import type { Artifact, Run } from '@/shared/api/types'
import { isTerminal, mergeEvents, runErrorMessage, type NumberedEvent } from './runState'

/** 串行轮询等待时长：上一轮请求结束后再等待该时长才读下一次。 */
export const RUN_POLL_INTERVAL = 1500

export type RunAction = 'approve' | 'reject' | 'cancel'

interface DetailState {
  run: Run | null
  events: NumberedEvent[]
  artifacts: Artifact[]
  loading: boolean
  refreshing: boolean
  error: string
  artifactError: string
  actionError: string
  saving: boolean
}

const initialState: DetailState = {
  run: null,
  events: [],
  artifacts: [],
  loading: true,
  refreshing: false,
  error: '',
  artifactError: '',
  actionError: '',
  saving: false,
}

type DetailAction =
  | { type: 'reset' }
  | { type: 'run'; run: Run }
  | { type: 'patch'; patch: Partial<DetailState> }

function reducer(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case 'reset':
      return initialState
    case 'run':
      return { ...state, run: action.run, events: mergeEvents(state.events, action.run.events) }
    case 'patch':
      return { ...state, ...action.patch }
  }
}

export interface RunDetailState extends DetailState {
  /** 手动刷新，强制重读产物。 */
  refresh: () => void
  /** 审批、打回、取消：先等在途读取结束再提交，返回服务响应后是否成功。 */
  act: (action: RunAction, body?: Record<string, string>) => Promise<boolean>
}

/**
 * 运行详情读取：1500ms 串行轮询，慢请求不叠加，终态停止，标识变化或卸载清理。
 * 事件按 API 事件 ID 去重并保留首次分配的展示序号，产物按 updatedAt 订阅刷新。
 */
export function useRunDetail(id: string): RunDetailState {
  const [state, dispatch] = useReducer(reducer, initialState)
  const idRef = useRef(id)
  const savingRef = useRef(false)
  const terminalRef = useRef(false)
  const artifactFailedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const pendingRef = useRef<Promise<void> | undefined>(undefined)
  const generationRef = useRef(0)
  const disposedRef = useRef(false)
  const revisionRef = useRef('')
  const loadRef = useRef<(forceArtifacts?: boolean) => Promise<void>>(async () => {})

  const markSaving = useCallback((saving: boolean) => {
    savingRef.current = saving
    dispatch({ type: 'patch', patch: { saving } })
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const accept = useCallback((value: Run) => {
    terminalRef.current = isTerminal(value.status)
    dispatch({ type: 'run', run: value })
  }, [])

  const schedule = useCallback(() => {
    clearTimer()
    if (disposedRef.current || savingRef.current || terminalRef.current) return
    timerRef.current = setTimeout(() => { void loadRef.current() }, RUN_POLL_INTERVAL)
  }, [clearTimer])

  const load = useCallback((forceArtifacts = false): Promise<void> => {
    if (disposedRef.current || savingRef.current) return Promise.resolve()
    if (pendingRef.current) return pendingRef.current
    clearTimer()
    const current = generationRef.current
    const target = idRef.current
    const request = new AbortController()
    controllerRef.current = request
    dispatch({ type: 'patch', patch: { refreshing: true } })
    const task = (async () => {
      try {
        const result = await api.get<Run>(`/runs/${encodeURIComponent(target)}`, request.signal)
        if (disposedRef.current || current !== generationRef.current) return
        accept(result)
        dispatch({ type: 'patch', patch: { error: '' } })
        if (forceArtifacts || revisionRef.current !== result.updatedAt || artifactFailedRef.current) {
          try {
            const values = await api.get<Artifact[]>(`/artifacts?runId=${encodeURIComponent(target)}`, request.signal)
            if (disposedRef.current || current !== generationRef.current) return
            revisionRef.current = result.updatedAt
            artifactFailedRef.current = false
            dispatch({ type: 'patch', patch: { artifacts: values, artifactError: '' } })
          } catch (cause) {
            if (!request.signal.aborted && current === generationRef.current) {
              artifactFailedRef.current = true
              dispatch({ type: 'patch', patch: { artifactError: runErrorMessage(cause) } })
            }
          }
        }
      } catch (cause) {
        if (!request.signal.aborted && current === generationRef.current) {
          dispatch({ type: 'patch', patch: { error: runErrorMessage(cause) } })
        }
      } finally {
        if (current === generationRef.current && !disposedRef.current) {
          dispatch({ type: 'patch', patch: { loading: false, refreshing: false } })
          pendingRef.current = undefined
          schedule()
        }
      }
    })()
    pendingRef.current = task
    return task
  }, [accept, clearTimer, schedule])

  const refresh = useCallback(() => { void load(true) }, [load])

  const act = useCallback(async (action: RunAction, body: Record<string, string> = {}): Promise<boolean> => {
    if (savingRef.current || disposedRef.current) return false
    markSaving(true)
    dispatch({ type: 'patch', patch: { actionError: '' } })
    clearTimer()
    const current = generationRef.current
    const target = idRef.current
    try {
      // 先结束在途读取，避免旧响应覆盖动作结果。
      await pendingRef.current
      if (disposedRef.current || current !== generationRef.current) return false
      const result = await api.post<Run>(`/runs/${encodeURIComponent(target)}/${action}`, body)
      if (disposedRef.current || current !== generationRef.current) return false
      accept(result)
      revisionRef.current = ''
      dispatch({ type: 'patch', patch: { error: '' } })
      return true
    } catch (cause) {
      if (!disposedRef.current && current === generationRef.current) {
        dispatch({ type: 'patch', patch: { actionError: runErrorMessage(cause) } })
      }
      return false
    } finally {
      if (!disposedRef.current && current === generationRef.current) {
        markSaving(false)
        void load(true)
      }
    }
  }, [accept, clearTimer, load, markSaving])

  useEffect(() => { loadRef.current = load }, [load])

  useEffect(() => {
    idRef.current = id
    disposedRef.current = false
    generationRef.current++
    clearTimer()
    controllerRef.current?.abort()
    controllerRef.current = undefined
    pendingRef.current = undefined
    terminalRef.current = false
    artifactFailedRef.current = false
    revisionRef.current = ''
    markSaving(false)
    // 运行标识变化必须清空上一次运行的视图（事件序号、产物、错误）再开始轮询，属于同步外部数据源。
    dispatch({ type: 'reset' })
    void loadRef.current()
  }, [id, clearTimer, markSaving])

  useEffect(() => () => {
    disposedRef.current = true
    generationRef.current++
    clearTimer()
    controllerRef.current?.abort()
    controllerRef.current = undefined
  }, [clearTimer])

  return { ...state, refresh, act }
}
