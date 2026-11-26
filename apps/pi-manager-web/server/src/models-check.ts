import { HomeError } from './pi-home.ts'

/**
 * models.json provider 条目校验（对齐 pi-web 的 model-provider-check）。
 *
 * pi 加载 models.json 时为每个 provider 组合模型；一条不合规则的条目会让该
 * provider 整个丢失，并出现在每个会话的模型错误里，而其它 provider 照常工作。
 * 这里只镜像能独立判定的规则（pi `applyModelsJson()` 顶部两条），依赖 pi 目录
 * 的推断（例如继承内置 provider 的 baseUrl）交给 pi 自己报。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空 id 的模型会被 pi 丢弃，不算「有条目」。 */
function isWrittenModel(model: unknown): boolean {
  return !isRecord(model) || typeof model.id !== 'string' || model.id.trim().length > 0
}

/**
 * 抛 400：provider 条目会被 pi 整体拒绝。
 *
 * 只判定不依赖 pi 目录的两类：
 * - 完全空的对象（pi 组合后 provider 没有任何定义）；
 * - 自定义模型 provider 写 `oauth` 却不写 `baseUrl`。
 * 只写 `name` 或 `api` 的内置 provider 覆盖条目是合法的，不能误拒。
 */
export function checkProviderEntry(provider: string, entry: Record<string, unknown>): void {
  if (Object.keys(entry).length === 0) {
    throw new HomeError(`Provider ${provider} 是空条目，pi 会丢弃它`, 400, 'provider_entry_invalid')
  }
  const models = entry.models
  const hasModels = Array.isArray(models)
    ? models.some((model) => !isRecord(model) || typeof model.id !== 'string' || model.id.trim().length > 0)
    : isRecord(models) && Object.keys(models).length > 0
  if (entry.oauth && !entry.baseUrl && hasModels) {
    throw new HomeError(`Provider ${provider} 使用 oauth 且自带模型时必须写 baseUrl`, 400, 'provider_entry_invalid')
  }
}
