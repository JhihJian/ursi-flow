import { realpathSync, statSync, unlinkSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { listAgentProfiles, THINKING_LEVELS as AGENT_THINKING_LEVELS, type AgentProfile } from './agents.ts'
import { HomeError } from './pi-home.ts'
import { loadSdk, type Sdk } from './sdk.ts'

/**
 * 会话运行时：一次性任务与交互对话共用的一套装配与释放逻辑。
 *
 * 两者的差别只在使用方式：任务跑一轮就 dispose，对话保持着接收事件、可以继续发。
 * 装配规则必须只有一份，否则 home / 模型 / subagent 的校验口径会分叉。
 *
 * 为什么不自建 SessionManager：`createAgentSession` 默认按 `agentDir + cwd` 把会话
 * 写进 `<home>/sessions/--<escaped-cwd>--/`，与 pi CLI / pi-web 的分组规则一致。
 * 续聊时才显式 `SessionManager.open(file)`。
 */

/** 与 pi 的 ThinkingLevel 一致，直接复用 agent profile 那份定义，避免两处口径分叉。 */
export const THINKING_LEVELS = AGENT_THINKING_LEVELS
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export type SdkModule = Sdk
export type AgentSession = Awaited<ReturnType<Sdk['createAgentSession']>>['session']
type ExtensionUIContext = NonNullable<Parameters<AgentSession['bindExtensions']>[0]['uiContext']>

export interface AssemblyOptions {
  /** 已 realpath 的 pi home。 */
  home: string
  cwd?: string
  /** `provider/modelId`。 */
  model?: string
  thinkingLevel?: string
  subagent?: string | null
  /** 续聊：只接受落在该 home 的 sessions/ 下的绝对路径。 */
  sessionFile?: string | null
  /** 扩展 UI 上下文（对话用）；不传则不绑定交互能力，与一次性任务的行为一致。 */
  uiContext?: ExtensionUIContext
  abortHandler?: () => void
}

export interface AssembledSession {
  sdk: Sdk
  session: AgentSession
  home: string
  cwd: string
  /** 实际生效的模型，写成 `provider/modelId`；取不到时为 null。 */
  model: string | null
  thinkingLevel: string | null
  /** 会话恢复时模型被回退的说明，交给调用方回显。 */
  fallbackMessage: string | null
  sessionFile: string | null
  sessionId: string
}

/** 会话根：pi 的默认布局就是 `<home>/sessions`，管理台与对话都用这一个口径。 */
export function sessionRoot(home: string): string {
  return join(home, 'sessions')
}

export function normalizeThinkingLevel(raw: string | null | undefined): ThinkingLevel | null {
  if (!raw) return null
  if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
    throw new HomeError(
      `thinkingLevel 只能是 ${THINKING_LEVELS.join(' / ')}，收到 ${raw}`,
      400,
      'invalid_request',
    )
  }
  return raw as ThinkingLevel
}

export function resolveCwd(raw: string | undefined): string {
  // 不传时用服务进程的当前目录，与 pi CLI 的默认行为一致；home 只是配置来源。
  if (!raw || !raw.trim()) return process.cwd()
  const expanded = raw.trim().startsWith('~') ? join(homedir(), raw.trim().slice(1)) : raw.trim()
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
export function subagentScalar(profile: AgentProfile, key: string): string | null {
  for (const line of profile.extraKeys) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    if (m && m[1].toLowerCase() === key.toLowerCase()) {
      return m[2].replace(/^["']|["']$/g, '').trim() || null
    }
  }
  return null
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
): unknown {
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) {
    throw new HomeError(`model 需要写成 provider/modelId（收到 ${raw}）`, 400, 'invalid_request')
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
  return model
}

/**
 * 续聊的会话文件必须落在该 home 的 sessions/ 下。
 *
 * `SessionManager.open` 对不存在的路径会直接新建文件，不校验归属的话，任何调用方
 * 都能借服务端在任意路径写 JSONL，并让工具在 header 记录的任意目录里执行。
 */
export function assertSessionFileIn(home: string, raw: string): string {
  if (!raw.trim()) throw new HomeError('sessionFile 不能为空', 400, 'invalid_request')
  const expanded = raw.trim().startsWith('~') ? join(homedir(), raw.trim().slice(1)) : raw.trim()
  const target = resolve(expanded)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    throw new HomeError(`会话文件不存在：${target}`, 404, 'session_not_found')
  }
  let root: string
  try {
    root = realpathSync(sessionRoot(home))
  } catch {
    throw new HomeError(`${home} 下没有 sessions 目录`, 404, 'session_not_found')
  }
  if (!real.startsWith(`${root}${sep}`)) {
    throw new HomeError(`会话文件不在该 pi home 的 sessions 目录里：${real}`, 400, 'invalid_session_file')
  }
  return real
}

/**
 * 装配一个 AgentSession。参数校验全部前置：不装 SDK 也能拿到明确的参数错误。
 */
export async function assembleSession(options: AssemblyOptions): Promise<AssembledSession> {
  const thinking = normalizeThinkingLevel(options.thinkingLevel)
  const subagent = options.subagent ? resolveSubagent(options.home, options.subagent) : null

  // 续聊以会话文件里的 cwd 为唯一起点，不接受调用方另传 cwd。
  const resumeFile = options.sessionFile ? assertSessionFileIn(options.home, options.sessionFile) : null
  if (resumeFile && options.cwd && options.cwd.trim()) {
    throw new HomeError('续聊不接受 cwd：会话文件里已经记录了工作目录', 400, 'invalid_request')
  }

  const sdk = await loadSdk()
  const sessionManager = resumeFile ? sdk.SessionManager.open(resumeFile) : null
  const cwd = resumeFile
    ? resolveCwd(sessionManager?.getCwd() || undefined)
    : resolveCwd(options.cwd)

  // 会话与 pi CLI 共用分组规则：不传 sessionManager 时 SDK 按 agentDir + cwd
  // 建 `<home>/sessions/--<escaped-cwd>--/`，这些会话 CLI 与 pi-web 都能接着聊。
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: options.home,
    // subagent 正文就是这个子会话的系统提示：追加在 pi 默认系统提示之后，
    // 替换会把工具协议一并丢掉。续聊时 transcript 里已经有那套提示，不再追加。
    ...(subagent && !resumeFile
      ? { appendSystemPromptOverride: (base: string[]) => [...base, subagent.body] }
      : {}),
  })
  await loader.reload()

  // subagent 定义的其余约束：frontmatter 的 tools / model / thinking。
  const subagentTools = subagent ? parseSubagentTools(subagentScalar(subagent, 'tools')) : null
  const modelRef =
    options.model ?? (subagent && !resumeFile ? subagentScalar(subagent, 'model') : null)
  const effectiveThinking =
    thinking ?? (subagent && !resumeFile ? normalizeThinkingLevel(subagentScalar(subagent, 'thinking')) : null)

  // 只有显式指定模型时才自建 ModelRuntime：它绑定该 home 的 auth.json / models.json，
  // 不指定时 createAgentSession 自己就按 agentDir 建同样的 runtime。
  const modelRuntime = modelRef
    ? await sdk.ModelRuntime.create({
        authPath: join(options.home, 'auth.json'),
        modelsPath: join(options.home, 'models.json'),
      })
    : null
  const model = modelRef && modelRuntime ? resolveModel(modelRuntime, modelRef, options.home) : null

  const created = await sdk.createAgentSession({
    cwd,
    agentDir: options.home,
    resourceLoader: loader,
    ...(sessionManager ? { sessionManager } : {}),
    ...(model ? { model: model as never } : {}),
    ...(modelRuntime ? { modelRuntime } : {}),
    ...(effectiveThinking ? { thinkingLevel: effectiveThinking as ThinkingLevel } : {}),
    // subagent 声明的工具集就是它的作用域；未声明则沿用 pi 的默认工具。续聊沿用文件里的记录。
    ...(subagentTools && subagentTools.length > 0 && !resumeFile ? { tools: subagentTools } : {}),
  })
  const session = created.session

  if (options.uiContext) {
    await session.bindExtensions({
      uiContext: options.uiContext,
      mode: 'rpc',
      ...(options.abortHandler ? { abortHandler: options.abortHandler } : {}),
      onError: () => undefined,
    })
  }

  const effectiveModel = session.model
  return {
    sdk,
    session,
    home: options.home,
    cwd,
    model: effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : null,
    thinkingLevel: session.thinkingLevel ?? null,
    fallbackMessage: created.modelFallbackMessage ?? null,
    sessionFile: session.sessionManager.getSessionFile() ?? null,
    sessionId: session.sessionManager.getSessionId(),
  }
}

/**
 * 释放一个会话。
 *
 * 顺序对齐 SDK 的 runtime 语义：先中止，再释放，最后等凭据写完（OAuth 刷新可能
 * 已经花掉旧的一次性 refresh token，不等落盘会丢登录）。
 *
 * 心跳文件是最后一件事：SDK 的 `session.dispose()` 不会发 `session_shutdown`，
 * 而心跳扩展靠那个事件删文件。直接放着会让会话在会话模块里以「运行中」挂到
 * 60 秒超时，因此这里只删本进程写下的那一个心跳文件（pid 匹配才算）。
 */
export async function disposeSession(session: AgentSession, home?: string | null): Promise<void> {
  const sessionId = session.sessionManager.getSessionId()
  try {
    await session.abort()
  } catch {
    /* 释放必须走完 */
  }
  try {
    session.dispose()
  } catch {
    /* 同上 */
  }
  try {
    await session.modelRuntime.settleCredentialWrites()
  } catch {
    /* 凭据落盘失败不该挡住释放 */
  }
  if (home) clearOwnHeartbeat(home, sessionId)
}

function clearOwnHeartbeat(home: string, sessionId: string): void {
  const file = join(home, 'state', 'running-sessions', `${sessionId}.json`)
  if (!existsSync(file)) return
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    if (typeof raw.pid === 'number' && raw.pid !== process.pid) return
    unlinkSync(file)
  } catch {
    /* 心跳是旁路信息，失败不影响释放 */
  }
}
