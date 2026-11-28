import { apiUrlOf } from '../config/api/client'

/**
 * 会话运行事实的契约：与 server/src/facts/types.ts 的 SessionFacts 同构。
 *
 * 「运行事实」是这次会话**实际上**用了什么模型、看到哪些 skills、连了哪些 MCP server、
 * 有哪些工具，由服务端给出（活会话取运行时，其余从会话文件重放），前端只读不推断。
 * 可选的 null 表示「会话文件里没有记」，不表示「会话里没有」。
 */

/** 模型的身份：provider 与 modelId，和会话文件里的写法一致。 */
export interface ModelIdentity {
  provider: string
  model: string
}

/** 一次模型切换：切换后用的模型，以及切换发生的时间（epoch 毫秒）。 */
export interface ModelChange extends ModelIdentity {
  at: number
}

/** 一个 skill 的名字与 SKILL.md 的绝对路径。 */
export interface SkillRef {
  name: string
  location: string
}

/** 一次会话的运行事实。 */
export interface SessionFacts {
  /** `file`：从会话 JSONL 重放；`runtime`：由 pi SDK 运行时直接给出。 */
  source: 'file' | 'runtime'
  model: {
    initial: ModelIdentity | null
    current: ModelIdentity | null
    thinkingLevel: string | null
    changes: ModelChange[]
  }
  skills: {
    /** 系统提示词里列出的 skills，即模型当时看到的清单。 */
    listed: SkillRef[] | null
    /** 用户在消息里展开读取过详情的 skills。 */
    read: SkillRef[] | null
  }
  mcp: {
    /** 尽力推断出的 MCP server 名；无法推断时为 null。 */
    servers: string[] | null
    /** 推断口径的说明，与 servers 同时为 null 或同时有值。 */
    note: string | null
  }
  tools: {
    /** 声明给模型的工具名。 */
    names: string[] | null
  }
  /** 系统提示词分区名，按声明的先后顺序。 */
  promptSectionKeys: string[] | null
  /** 会话文件是否记录了系统提示词与工具声明。老会话只记消息，这些事实无从得知。 */
  recorded: boolean
  reason?: 'not_recorded'
}

/**
 * 取一条会话的运行事实。
 *
 * 拉不到就算没有：路由还没上、会话没有本地运行时（409）、会话已被删除（404）、
 * 网络失败，一律返回 null，由调用方整块隐藏面板。断言失败同理，坏数据不进界面。
 */
export async function fetchSessionFacts(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionFacts | null> {
  if (!sessionId) return null
  try {
    const res = await fetch(apiUrlOf(`/api/sessions/${encodeURIComponent(sessionId)}/facts`), { signal })
    if (!res.ok) return null
    const json: unknown = await res.json().catch(() => null)
    return isSessionFacts(json) ? json : null
  } catch {
    return null
  }
}

/** 只校验面板会用到的骨架：字段缺失时按「拿不到」处理，不让界面读到 undefined。 */
function isSessionFacts(value: unknown): value is SessionFacts {
  if (typeof value !== 'object' || value === null) return false
  const facts = value as Partial<SessionFacts>
  const object = (field: unknown) => typeof field === 'object' && field !== null
  return (
    typeof facts.recorded === 'boolean' &&
    object(facts.model) &&
    object(facts.skills) &&
    object(facts.mcp) &&
    object(facts.tools)
  )
}
