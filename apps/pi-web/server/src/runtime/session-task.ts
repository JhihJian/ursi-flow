import {
  THINKING_LEVELS,
  assembleSession,
  disposeSession,
  parseSubagentTools,
  resolveSubagent,
  type AgentSession,
} from './session-runtime.ts'
import { HomeError } from '../shared/pi-home.ts'
import { loadSdk } from '../shared/sdk.ts'
import { profileRevisionOf } from '../config/registry.ts'
import { MAX_TASKS as MAX_TASKS_VALUE, TASK_TIMEOUT_MS } from '../config.ts'
import { detachRuntime, syncRuntime, transition } from '../sessions/registry.ts'

/**
 * 一次性会话任务：用 pi SDK 在指定 pi home 下起一个 AgentSession，跑完一轮就结束。
 *
 * 两层身份，不要混淆：
 * - **agent 是一份 pi home**。它自带模型、凭据、skills、subagent 定义与 MCP 设置，
 *   所以不同 home 里的同名 subagent 属于不同 agent。调用方用 home 的 name 指定。
 * - **subagent 是 agents/*.md 定义的一种"特别的工具"**：会话里的 Agent 工具按
 *   `subagent_type` 派生一个子会话，profile 文件就是该取值的定义（正文即子会话的
 *   系统提示，frontmatter 约束工具集与模型）。它不是可选人设，而是工具的参数枚举。
 *
 * 因此本接口的 `subagent` 参数含义是「直接以该 subagent 的定义起一个会话」，
 * 等价于父会话调用一次 Agent 工具；省略时起普通主会话，由它自己决定是否派生。
 *
 * 会话的装配与释放逻辑在 `session-runtime.ts` 里，与交互对话共用；这里只负责
 * 「跑一轮、记录结果、限流」。
 *
 * SDK 按需加载：没装 @earendil-works/pi-coding-agent 时管理台仍能正常管理配置，
 * 只有执行接口返回 503。
 */

export { parseSubagentTools, resolveSubagent }

export type TaskState = 'running' | 'done' | 'error' | 'cancelled'

export interface SessionTask {
  sessionId: string
  /** agent 身份 = 这份 pi home 在清单里的 name。 */
  agent: string
  home: string
  /** 本次按其定义执行的 subagent（agents/<name>.md）；空表示普通主会话。 */
  subagent: string | null
  instruct: string
  cwd: string
  state: TaskState
  startedAt: number
  finishedAt: number | null
  /** 成功时的最后一条助手文本。 */
  answer: string | null
  /** 失败时的错误说明。 */
  error: string | null
  /** 会话文件（相对 home 或绝对路径），由 SDK 的 SessionManager 决定。 */
  sessionFile: string | null
  /** 运行中累计的助手文本长度，用于观察进度。 */
  textLength: number
}

export interface StartOptions {
  /** agent 身份（pi home 的 name）；只用于任务记录与回显。 */
  agent: string
  /** 已解析的 pi home 路径：所有配置与 session 都落在这里。 */
  home: string
  /** 可选的 subagent 类型（agents/<name>.md）；等价于 Agent 工具的 subagent_type。 */
  subagent: string | null
  instruct: string
  cwd?: string
  model?: string
  thinkingLevel?: string
}

const MAX_TASKS = MAX_TASKS_VALUE
const DEFAULT_TIMEOUT_MS = TASK_TIMEOUT_MS

/** 进程内任务表：会话是活的运行时对象，不落盘也无法跨进程共享。 */
const tasks = new Map<string, SessionTask>()
/** 运行中的会话句柄，用于取消。 */
const live = new Map<string, { abort: () => Promise<void>; dispose: () => Promise<void> }>()

export function taskCapacity(): { running: number; limit: number } {
  let running = 0
  for (const task of tasks.values()) if (task.state === 'running') running += 1
  return { running, limit: MAX_TASKS }
}

export function getTask(sessionId: string): SessionTask | null {
  return tasks.get(sessionId) ?? null
}

export function listTasks(home?: string): SessionTask[] {
  const all = [...tasks.values()]
  const filtered = home ? all.filter((task) => task.home === home) : all
  return filtered.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * 启动一次会话任务并立即返回 session id：会话可能跑很久，HTTP 请求不该等它。
 * 后台执行，结果通过 getTask() 查询。
 */
export async function startSessionTask(options: StartOptions): Promise<SessionTask> {
  const instruct = options.instruct.trim()
  if (!instruct) throw new HomeError('instruct 不能为空', 400, 'invalid_request')

  const capacity = taskCapacity()
  if (capacity.running >= capacity.limit) {
    throw new HomeError(
      `同时运行的会话已达上限 ${capacity.limit}，等待现有任务结束或先取消`,
      429,
      'too_many_tasks',
    )
  }

  // 纯参数校验全部前置：不装 SDK 也能拿到明确的参数错误，测试也不必加载运行时。
  if (options.thinkingLevel && !(THINKING_LEVELS as readonly string[]).includes(options.thinkingLevel)) {
    throw new HomeError(
      `thinkingLevel 只能是 ${THINKING_LEVELS.join(' / ')}，收到 ${options.thinkingLevel}`,
      400,
      'invalid_request',
    )
  }
  if (options.model && !/^[^/]+\/.+$/.test(options.model)) {
    throw new HomeError(
      `model 需要写成 provider/modelId（收到 ${options.model}）`,
      400,
      'invalid_request',
    )
  }
  if (options.subagent) resolveSubagent(options.home, options.subagent)

  // 会话创建放在返回前：agent 不存在、模型不存在、凭据缺失都能立刻报给调用方。
  const assembled = await assembleSession({
    home: options.home,
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    subagent: options.subagent,
  })

  // 任务总是新会话：实体通常还不存在，这次迁移是 no-op；若同一份文件已经被扫到，
  // 先标成装配中，下面的 syncRuntime 再把它落成 running。
  try {
    transition(assembled.sessionId, 'loading')
  } catch (error) {
    await disposeSession(assembled.session, options.home)
    throw error
  }

  const task: SessionTask = {
    sessionId: assembled.sessionId,
    agent: options.agent,
    home: options.home,
    subagent: options.subagent ? options.subagent.replace(/\.md$/i, '') : null,
    instruct,
    cwd: assembled.cwd,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    answer: null,
    error: null,
    sessionFile: assembled.sessionFile,
    textLength: 0,
  }
  tasks.set(task.sessionId, task)
  syncTaskEntity(task)

  live.set(task.sessionId, {
    abort: () => assembled.session.abort(),
    dispose: () => disposeSession(assembled.session, options.home),
  })

  void runTask({ session: assembled.session, task, home: options.home }).catch((error: unknown) => {
    finish(task, 'error', error instanceof Error ? error.message : String(error))
    void disposeSession(assembled.session, options.home)
  })

  return task
}

function syncTaskEntity(task: SessionTask): void {
  const running = task.state === 'running'
  syncRuntime({
    sessionId: task.sessionId,
    kind: 'task',
    homePath: task.home,
    filePath: task.sessionFile,
    cwd: task.cwd,
    toState: running ? 'running' : task.state === 'error' ? 'failed' : 'ready',
    model: null,
    queue: 0,
    interactions: 0,
    error: task.error ? { message: task.error, phase: 'turn' } : null,
    profileRevision: profileRevisionOf(task.home),
    execution: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      outcome: running ? 'running' : task.state === 'cancelled' ? 'cancelled' : task.state === 'done' ? 'ok' : 'error',
      outputLength: task.textLength,
      lastText: task.answer ?? '',
    },
    instanceId: `task:${task.sessionId}`,
  })
}

function finish(task: SessionTask, state: TaskState, error: string | null, answer?: string): void {
  // 只允许从 running 迁移一次：取消会把状态先定成 cancelled，随后 runTask 的收尾不再覆盖。
  if (task.state !== 'running') return
  task.state = state
  task.error = error
  if (answer !== undefined) task.answer = answer
  task.finishedAt = Date.now()
  live.delete(task.sessionId)
  syncTaskEntity(task)
}

async function runTask(args: { session: AgentSession; task: SessionTask; home: string }): Promise<void> {
  const { session, task, home } = args
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      task.textLength += event.assistantMessageEvent.delta.length
    }
  })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`会话超过 ${DEFAULT_TIMEOUT_MS} ms 未结束，已中止`)),
      DEFAULT_TIMEOUT_MS,
    )
  })

  try {
    await Promise.race([session.prompt(task.instruct), timeout])
    const answer = session.getLastAssistantText?.() ?? null
    finish(task, 'done', null, answer ?? '')
  } catch (error) {
    finish(task, 'error', error instanceof Error ? error.message : String(error))
  } finally {
    if (timer) clearTimeout(timer)
    unsubscribe()
    // 无论成功、失败还是取消都在这里释放会话句柄。
    await disposeSession(session, home)
    live.delete(task.sessionId)
    detachRuntime(task.sessionId, `task:${task.sessionId}`)
  }
}

export async function cancelSessionTask(sessionId: string): Promise<void> {
  const task = tasks.get(sessionId)
  if (!task) throw new HomeError(`没有这个会话任务：${sessionId}`, 404, 'task_not_found')
  if (task.state !== 'running') {
    throw new HomeError(`会话任务已结束（${task.state}）`, 409, 'task_finished')
  }
  // 先落终态：调用方立刻能查到 cancelled，随后 abort 触发的收尾不会覆盖它。
  finish(task, 'cancelled', '调用方取消了会话')
  const handle = live.get(sessionId)
  if (handle) await handle.abort()
}

/**
 * 取消一条正在运行的一次性任务；没有运行中的任务时返回 false。
 *
 * 与 `cancelSessionTask` 的区别：它不抛错也不等收尾，供「一个 abort 按钮管两种运行时」
 * 的路由用——有任务就取消任务，没有任务再交给对话运行时。
 */
export function abortSessionTask(sessionId: string): boolean {
  const task = tasks.get(sessionId)
  if (!task || task.state !== 'running') return false
  finish(task, 'cancelled', '调用方取消了会话')
  void live.get(sessionId)?.abort().catch(() => undefined)
  return true
}

/** 供测试与自检：SDK 是否可用。 */
export async function sdkAvailable(): Promise<boolean> {
  try {
    await loadSdk()
    return true
  } catch {
    return false
  }
}
