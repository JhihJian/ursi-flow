import { replay } from '../facts/replay.ts'
import type { SessionFacts } from '../facts/types.ts'
import { parseModelRef, transcriptOf, type ChatRecord } from './chat.ts'

/**
 * 运行事实的运行时投影。
 *
 * 事实的权威来源是会话 JSONL：`facts/replay.ts` 把它重放成 `SessionFacts`。
 * 但活会话有重放拿不到的部分（模型还没落盘、工具集是运行时算出来的），
 * 这些字段由运行时直接给，字段级覆盖在重放结果上，口径比配置目录可靠。
 */

/** 活会话当前的行文本：与轨迹接口、事件流首帧同一份拼法。 */
export function liveFactsText(chat: ChatRecord): string {
  return transcriptOf(chat.session)
}

/**
 * 重放结果 + 运行时字段级覆盖。
 *
 * - 模型与思考等级以运行时为准：会话刚切换过模型时文件里还可能是旧值。
 * - 工具名以运行时的活跃工具为准（`getActiveToolNames`，即声明给模型的那批）；
 *   取不到就保留重放结果。
 * - MCP 不覆盖：运行时没有权威清单，保持重放的尽力推断与 note。
 */
export function projectLiveFacts(chat: ChatRecord, jsonl: string): SessionFacts {
  const facts = replay(jsonl)
  const live = parseModelRef(chat.model, chat.thinkingLevel)
  const tools = activeToolNames(chat)
  return {
    ...facts,
    source: 'runtime',
    model: {
      ...facts.model,
      ...(live ? { current: { provider: live.provider, model: live.modelId } } : {}),
      ...(live?.thinkingLevel ? { thinkingLevel: live.thinkingLevel } : {}),
    },
    tools: { names: tools ?? facts.tools.names },
  }
}

/** 活跃工具名：SDK 旧版本没有这个方法时返回 null，调用方保留重放结果。 */
function activeToolNames(chat: ChatRecord): string[] | null {
  const getter = (chat.session as { getActiveToolNames?: () => string[] }).getActiveToolNames
  if (typeof getter !== 'function') return null
  try {
    return getter.call(chat.session) ?? null
  } catch {
    return null
  }
}
