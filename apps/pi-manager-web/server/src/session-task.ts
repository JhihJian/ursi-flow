import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { listAgentProfiles, type AgentProfile } from './agents.ts'
import { HomeError } from './pi-home.ts'
import { loadSdk, type Sdk } from './sdk.ts'

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
 * 与管理台其余部分的分工：其他模块只读写配置文件，不启动会话；这里明确是"执行"
 * 能力，因此单独成模块、单独限流。session 写回该 home 的
 * sessions 目录，和 pi CLI / pi-web 的会话并列。
 *
 * SDK 按需加载：没装 @earendil-works/pi-coding-agent 时管理台仍能正常管理配置，
 * 只有执行接口返回 503。
 */

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

const MAX_TASKS = Number.parseInt(process.env.PI_MANAGER_MAX_TASKS ?? '4', 10) || 4
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PI_MANAGER_TASK_TIMEOUT_MS ?? '600000', 10) || 600_000

/** 进程内任务表：会话是活的运行时对象，不落盘也无法跨进程共享。 */
const tasks = new Map<string, SessionTask>()
/** 运行中的会话句柄，用于取消。 */
const live = new Map<string, { abort: () => Promise<void>; dispose: () => void }>()

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]

type AgentSession = Awaited<ReturnType<Sdk['createAgentSession']>>['session']

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
 * 找一个 subagent 定义：先按文件名，再按 frontmatter 的 name（都不区分大小写）。
 * 这些文件就是会话内 Agent 工具的 subagent_type 取值。
 */
export function resolveSubagent(home: string, name: string): AgentProfile {
  const wanted = name.trim().toLowerCase()
  const profiles = listAgentProfiles(home)
  const found = profiles.find(
    (p) => p.file.replace(/\.md$/i, '').toLowerCase() === wanted || p.name.toLowerCase() === wanted,
  )
  if (!found) {
    const known = profiles.map((p) => p.file.replace(/\.md$/i, ''))
    throw new HomeError(
      `该 pi home 里没有这个 subagent：${name}${known.length ? `（可选：${known.join('、')}）` : '（agents/ 目录为空）'}`,
      404,
      'subagent_not_found',
    )
  }
  return found
}

/** 从 subagent 定义的 frontmatter 取一个标量值（extraKeys 是 "key: value" 原样行）。 */
function subagentScalar(profile: AgentProfile, key: string): string | null {
  for (const line of profile.extraKeys) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    if (m && m[1].toLowerCase() === key.toLowerCase()) {
      return m[2].replace(/^["']|["']$/g, '').trim() || null
    }
  }
  return null
}

function resolveCwd(raw: string | undefined): string {
  // 不传时用服务进程的当前目录，与 pi CLI 的默认行为一致；home 只是配置来源。
  if (!raw || !raw.trim()) return process.cwd()
  const home = homedir()
  const expanded = raw.trim().startsWith('~')
    ? join(home, raw.trim().slice(1))
    : raw.trim()
  const target = resolve(expanded)
  try {
    if (!statSync(target).isDirectory()) {
      throw new HomeError(`cwd 不是目录：${target}`, 400, 'invalid_request')
    }
  } catch (error) {
    if (error instanceof HomeError) throw error
    throw new HomeError(`cwd 不存在：${target}`, 404, 'cwd_not_found')
  }
  return target
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
  const thinking = options.thinkingLevel
  if (thinking && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new HomeError(
      `thinkingLevel 只能是 ${THINKING_LEVELS.join(' / ')}，收到 ${thinking}`,
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

  const subagent = options.subagent ? resolveSubagent(options.home, options.subagent) : null
  const cwd = resolveCwd(options.cwd)
  const sdk = await loadSdk()

  // 会话与 pi CLI 共用分组规则：不传 sessionManager 时 SDK 按 agentDir + cwd
  // 建 `<home>/sessions/--<escaped-cwd>--/`，这些会话 CLI 与 pi-web 都能接着聊。
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: options.home,
    // subagent 正文就是这个子会话的系统提示：追加在 pi 默认系统提示之后，
    // 替换会把工具协议一并丢掉。
    ...(subagent ? { appendSystemPromptOverride: (base: string[]) => [...base, subagent.body] } : {}),
  })
  await loader.reload()

  // subagent 定义的其余约束：frontmatter 的 tools / model / thinking。
  const subagentTools = subagent ? parseSubagentTools(subagentScalar(subagent, 'tools')) : null
  const modelRef = options.model ?? (subagent ? subagentScalar(subagent, 'model') : null)
  const effectiveThinking = thinking ?? (subagent ? subagentScalar(subagent, 'thinking') : null)
  if (effectiveThinking && !THINKING_LEVELS.includes(effectiveThinking as ThinkingLevel)) {
    throw new HomeError(
      `subagent 里的 thinking 不是合法值：${effectiveThinking}（可选 ${THINKING_LEVELS.join(' / ')}）`,
      400,
      'invalid_subagent',
    )
  }

  // 只有显式指定模型时才自建 ModelRuntime：它绑定该 home 的 auth.json / models.json，
  // 不指定时 createAgentSession 自己就按 agentDir 建同样的 runtime。
  const modelRuntime = modelRef
    ? await sdk.ModelRuntime.create({
        authPath: join(options.home, 'auth.json'),
        modelsPath: join(options.home, 'models.json'),
      })
    : null
  const model = modelRef && modelRuntime ? resolveModel(modelRuntime, modelRef, options.home) : null

  // 会话创建放在返回前：agent 不存在、模型不存在、凭据缺失都能立刻报给调用方。
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: options.home,
    resourceLoader: loader,
    ...(model ? { model } : {}),
    ...(modelRuntime ? { modelRuntime } : {}),
    ...(effectiveThinking ? { thinkingLevel: effectiveThinking as ThinkingLevel } : {}),
    // subagent 声明的工具集就是它的作用域；未声明则沿用 pi 的默认工具。
    ...(subagentTools && subagentTools.length > 0 ? { tools: subagentTools } : {}),
  })

  const sessionId = session.sessionManager.getSessionId()
  const task: SessionTask = {
    sessionId,
    agent: options.agent,
    home: options.home,
    subagent: subagent ? subagent.file.replace(/\.md$/i, '') : null,
    instruct,
    cwd,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    answer: null,
    error: null,
    sessionFile: session.sessionManager.getSessionFile() ?? null,
    textLength: 0,
  }
  tasks.set(sessionId, task)

  live.set(sessionId, {
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  })

  void runTask({ session, task }).catch((error: unknown) => {
    finish(task, 'error', error instanceof Error ? error.message : String(error))
    session.dispose()
  })

  return task
}

function finish(task: SessionTask, state: TaskState, error: string | null, answer?: string): void {
  // 只允许从 running 迁移一次：取消会把状态先定成 cancelled，随后 runTask 的收尾不再覆盖。
  if (task.state !== 'running') return
  task.state = state
  task.error = error
  if (answer !== undefined) task.answer = answer
  task.finishedAt = Date.now()
  live.delete(task.sessionId)
}

async function runTask(args: { session: AgentSession; task: SessionTask }): Promise<void> {
  const { session, task } = args
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
    session.dispose()
    live.delete(task.sessionId)
  }
}

/** subagent 的 `tools:` 是逗号分隔的工具名；空值或 "none" 表示不给工具。 */
export function parseSubagentTools(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && name.toLowerCase() !== 'none')
}

/** "provider/modelId" 解析到 Model；找不到就明确报错，不静默回落到默认模型。 */
function resolveModel(
  runtime: { getModel: (provider: string, modelId: string) => unknown },
  raw: string,
  home: string,
): never {
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) {
    throw new HomeError(
      `model 需要写成 provider/modelId（收到 ${raw}）`,
      400,
      'invalid_request',
    )
  }
  const provider = raw.slice(0, slash)
  const modelId = raw.slice(slash + 1)
  const model = runtime.getModel(provider, modelId)
  if (!model) {
    throw new HomeError(
      `该 pi home 里没有这个模型：${raw}（检查 ${join(home, 'models.json')} 与 pi 内置模型列表）`,
      404,
      'model_not_found',
    )
  }
  return model as never
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

/** 供测试与自检：SDK 是否可用。 */
export async function sdkAvailable(): Promise<boolean> {
  try {
    await loadSdk()
    return true
  } catch {
    return false
  }
}
