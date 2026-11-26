import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EngineError,
  FileLogStore,
  FlowEngine,
  builtinExecutors,
  findExecutor,
} from 'ursi-flow'
import type {
  ExecutorAdapter,
  FlowSource,
  FlowVariables,
  LogEvent,
  PendingConfirm,
  RunSnapshot,
  RunStatus,
  StoredRun,
  CompletedStep,
} from 'ursi-flow'
import { ready } from 'ursi-flow/core'

export interface RunSummary {
  runId: string
  flowId: string
  /** 这次运行使用的执行器标识。 */
  executor: string
  status: RunStatus
  startedAt: string
  updatedAt: string
  /** 已完成的步骤数。 */
  stepCount: number
  failure?: { code: string; message: string }
}

export interface RunView extends RunSummary {
  flowPath?: string
  cwd?: string
  variables: FlowVariables
  steps: CompletedStep[]
  pending?: PendingConfirm
  events: LogEvent[]
  /** 本进程内还在执行的运行。 */
  active: boolean
}

export interface StartInput {
  flow: FlowSource
  variables?: FlowVariables
  cwd?: string
  /** 执行器标识；缺省用服务端的默认执行器。 */
  executor?: string
}

export interface RunService {
  executors(): ExecutorAdapter[]
  defaultExecutor(): string
  start(input: StartInput): Promise<{ runId: string }>
  list(limit?: number): Promise<RunSummary[]>
  view(runId: string): Promise<RunView | undefined>
  confirm(runId: string, stepId: string, result: string): Promise<RunView>
  resume(runId: string): Promise<RunView>
  stop(runId: string, reason?: string): Promise<RunView>
}

const RUN_ID = /^[A-Za-z0-9][\w-]{0,95}$/

/**
 * 运行服务：每个执行器一份引擎实例，共用同一个存储。
 * 运行头记录执行器标识，查询与恢复都按它选回对应的引擎，
 * 因此换执行器不会把旧运行接到新实现上。
 */
export function createRunService(options: {
  runsRoot: string
  adapters?: ExecutorAdapter[]
  now?: () => string
}): RunService {
  const adapters = options.adapters ?? builtinExecutors
  const defaultExecutor = adapters[0]?.id ?? ''
  const store = new FileLogStore(options.runsRoot)
  const now = options.now ?? (() => new Date().toISOString())
  const engines = new Map<string, FlowEngine>()
  const active = new Map<string, { startedAt: string }>()

  function requireAdapter(id: string): ExecutorAdapter {
    const adapter = findExecutor(id, adapters)
    if (adapter === undefined)
      throw new EngineError(
        'invalid',
        `未接入的执行器：${id}，可用：${adapters.map((item) => item.id).join('、')}`,
      )
    return adapter
  }

  function engineOf(id: string): FlowEngine {
    const adapter = requireAdapter(id)
    const existing = engines.get(id)
    if (existing !== undefined) return existing
    const engine = new FlowEngine({
      store,
      executor: adapter.create(),
      now,
    })
    engines.set(id, engine)
    return engine
  }

  /** 运行用哪个引擎由运行头决定，不取当前的默认执行器。 */
  async function engineFor(runId: string): Promise<FlowEngine> {
    assertRunId(runId)
    const stored = await store.load(runId).catch(() => undefined)
    if (stored === undefined)
      throw new EngineError('not_found', `运行不存在：${runId}`)
    return engineOf(stored.header.executor)
  }

  async function start(input: StartInput): Promise<{ runId: string }> {
    const executorId = input.executor ?? defaultExecutor
    requireAdapter(executorId)
    // 启动变量与定义在开跑前先校验一次：非法输入同步报错，不留下半截运行。
    try {
      ready(input.flow.text, {
        flowId: input.flow.id,
        variables: input.variables ?? {},
      })
    } catch (error) {
      throw new EngineError('invalid', messageOf(error))
    }
    const runId = randomUUID()
    const startedAt = now()
    active.set(runId, { startedAt })
    const engine = engineOf(executorId)
    void (async () => {
      try {
        await engine.start({
          flow: input.flow,
          runId,
          ...(input.variables === undefined ? {} : { variables: input.variables }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        })
      } finally {
        active.delete(runId)
      }
    })()
    return { runId }
  }

  async function list(limit = 100): Promise<RunSummary[]> {
    const dirs = await readdir(join(options.runsRoot, 'runs'), {
      withFileTypes: true,
    }).catch(() => [])
    const summaries: RunSummary[] = []
    for (const entry of dirs) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue
      const summary = await readSummary(entry.name)
      if (summary !== undefined) summaries.push(summary)
    }
    for (const [runId, state] of active) {
      if (summaries.some((summary) => summary.runId === runId)) continue
      summaries.push({
        runId,
        flowId: '',
        executor: '',
        status: 'running',
        startedAt: state.startedAt,
        updatedAt: state.startedAt,
        stepCount: 0,
      })
    }
    return summaries
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
  }

  /** 列表只读运行头与快照，不解析事件流。 */
  async function readSummary(runId: string): Promise<RunSummary | undefined> {
    const dir = join(options.runsRoot, 'runs', runId)
    const header = await readJson<{
      flowId: string
      executor?: string
      startedAt: string
    }>(join(dir, 'run.json'))
    const snapshot = await readJson<RunSnapshot>(join(dir, 'snapshot.json'))
    if (header === undefined || snapshot === undefined) {
      const state = active.get(runId)
      if (state === undefined) return undefined
      return {
        runId,
        flowId: header?.flowId ?? '',
        executor: header?.executor ?? '',
        status: 'running',
        startedAt: header?.startedAt ?? state.startedAt,
        updatedAt: state.startedAt,
        stepCount: 0,
      }
    }
    return {
      runId,
      flowId: header.flowId,
      executor: header.executor ?? '',
      status: snapshot.status,
      startedAt: header.startedAt,
      updatedAt: snapshot.updatedAt,
      stepCount: snapshot.context.steps.length,
      ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
    }
  }

  async function view(runId: string): Promise<RunView | undefined> {
    assertRunId(runId)
    const stored = await store.load(runId).catch(() => undefined)
    if (stored === undefined) {
      const state = active.get(runId)
      if (state === undefined) return undefined
      return {
        runId,
        flowId: '',
        executor: '',
        status: 'running',
        startedAt: state.startedAt,
        updatedAt: state.startedAt,
        stepCount: 0,
        variables: {},
        steps: [],
        events: [],
        active: true,
      }
    }
    return toView(runId, stored, active.has(runId))
  }

  async function confirm(
    runId: string,
    stepId: string,
    result: string,
  ): Promise<RunView> {
    const engine = await engineFor(runId)
    await engine.respond(runId, stepId, result)
    return requireView(runId)
  }

  async function resume(runId: string): Promise<RunView> {
    const engine = await engineFor(runId)
    await engine.resume(runId)
    return requireView(runId)
  }

  /**
   * 停止正在运行的运行会与推进竞争，因此只允许停止不在执行中的运行
   * （等待确认、待核实或进程重启后遗留的运行）。
   */
  async function stop(runId: string, reason?: string): Promise<RunView> {
    const engine = await engineFor(runId)
    if (active.has(runId))
      throw new EngineError('conflict', '运行正在执行，暂时不能停止')
    await engine.stop(runId, reason)
    return requireView(runId)
  }

  async function requireView(runId: string): Promise<RunView> {
    const current = await view(runId)
    if (current === undefined)
      throw new EngineError('not_found', `运行不存在：${runId}`)
    return current
  }

  return {
    executors: () => adapters,
    defaultExecutor: () => defaultExecutor,
    start,
    list,
    view,
    confirm,
    resume,
    stop,
  }
}

/** 结束状态与待决确认之间只差一份快照字段，界面按状态分支渲染。 */
export function toView(
  runId: string,
  stored: StoredRun,
  isActive: boolean,
): RunView {
  const { header, snapshot, events } = stored
  return {
    runId,
    flowId: header.flowId,
    executor: header.executor ?? '',
    status: snapshot.status,
    startedAt: header.startedAt,
    updatedAt: snapshot.updatedAt,
    stepCount: snapshot.context.steps.length,
    ...(header.flowPath === undefined ? {} : { flowPath: header.flowPath }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    variables: snapshot.context.variables,
    steps: snapshot.context.steps,
    ...(snapshot.pending === undefined ? {} : { pending: snapshot.pending }),
    ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
    events,
    active: isActive,
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new EngineError('invalid', `非法的运行标识：${runId}`)
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
