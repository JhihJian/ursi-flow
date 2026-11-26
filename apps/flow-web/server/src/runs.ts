import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EngineError,
  FakeExecutor,
  FileLogStore,
  FlowEngine,
} from 'ursi-flow'
import { ready } from 'ursi-flow/core'
import type {
  CompletedStep,
  FlowExecutor,
  FlowSource,
  FlowVariables,
  LogEvent,
  PendingConfirm,
  RunSnapshot,
  RunStatus,
  StoredRun,
} from 'ursi-flow'

export interface RunSummary {
  runId: string
  flowId: string
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
}

export interface RunService {
  start(input: StartInput): Promise<{ runId: string }>
  list(limit?: number): Promise<RunSummary[]>
  view(runId: string): Promise<RunView | undefined>
  confirm(runId: string, stepId: string, result: string): Promise<RunView>
  resume(runId: string): Promise<RunView>
  stop(runId: string, reason?: string): Promise<RunView>
}

const RUN_ID = /^[A-Za-z0-9][\w-]{0,95}$/

/** 当前接入的执行器名字，界面据此说明回执是怎么来的。 */
export const EXECUTOR_NAME = 'FakeExecutor'

/**
 * 运行服务：引擎负责推进，本服务只做运行登记、查询与人工确认转发。
 * 运行事实全部来自文件存储，进程重启后仍可查询与恢复。
 */
export function createRunService(options: {
  runsRoot: string
  executor?: FlowExecutor
  now?: () => string
}): RunService {
  const store = new FileLogStore(options.runsRoot)
  const engine = new FlowEngine({
    store,
    executor: options.executor ?? new FakeExecutor(),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const active = new Map<string, { startedAt: string }>()
  const errors = new Map<string, string>()
  const now = options.now ?? (() => new Date().toISOString())

  async function start(input: StartInput): Promise<{ runId: string }> {
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
    void (async () => {
      try {
        await engine.start({
          flow: input.flow,
          runId,
          ...(input.variables === undefined ? {} : { variables: input.variables }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        })
      } catch (error) {
        errors.set(runId, messageOf(error))
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
  async function readSummary(
    runId: string,
  ): Promise<RunSummary | undefined> {
    const dir = join(options.runsRoot, 'runs', runId)
    const header = await readJson<{
      flowId: string
      startedAt: string
    }>(join(dir, 'run.json'))
    const snapshot = await readJson<RunSnapshot>(join(dir, 'snapshot.json'))
    if (header === undefined || snapshot === undefined) {
      const state = active.get(runId)
      if (state === undefined) return undefined
      return {
        runId,
        flowId: '',
        status: 'running',
        startedAt: state.startedAt,
        updatedAt: state.startedAt,
        stepCount: 0,
      }
    }
    return {
      runId,
      flowId: header.flowId,
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
        status: 'running',
        startedAt: state.startedAt,
        updatedAt: state.startedAt,
        stepCount: 0,
        variables: {},
        steps: [],
        events: [],
        active: true,
        ...(errors.has(runId) ? { failure: { code: 'internal', message: errors.get(runId)! } } : {}),
      }
    }
    return toView(runId, stored, active.has(runId))
  }

  async function confirm(
    runId: string,
    stepId: string,
    result: string,
  ): Promise<RunView> {
    assertRunId(runId)
    await engine.respond(runId, stepId, result)
    return requireView(runId)
  }

  async function resume(runId: string): Promise<RunView> {
    assertRunId(runId)
    await engine.resume(runId)
    return requireView(runId)
  }

  /**
   * 停止正在运行的运行会与推进竞争，因此只允许停止不在执行中的运行
   * （等待确认、待核实或进程重启后遗留的运行）。
   */
  async function stop(runId: string, reason?: string): Promise<RunView> {
    assertRunId(runId)
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

  return { start, list, view, confirm, resume, stop }
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
