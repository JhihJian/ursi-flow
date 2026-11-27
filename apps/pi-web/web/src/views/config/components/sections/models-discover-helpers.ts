/**
 * 发现模型（上游 /models）与 provider 草稿之间的纯函数。
 *
 * 草稿 JSON 字符串是唯一真源：这里只算 diff、过滤和追加后的下一个条目，
 * 不持有自己的状态，UI 每次由草稿重算「已存在/缺失」。
 */

export type DraftModel = Record<string, unknown>

export function modelIdOf(model: DraftModel): string {
  return typeof model.id === 'string' ? model.id.trim() : ''
}

/** provider 草稿条目里的模型列表；对象映射形态展开成数组，非对象项丢弃。 */
export function modelsOf(entry: DraftModel): DraftModel[] {
  const models = entry.models
  if (Array.isArray(models)) {
    return models.filter(
      (item): item is DraftModel => item !== null && typeof item === 'object' && !Array.isArray(item),
    )
  }
  if (models && typeof models === 'object') {
    return Object.entries(models as Record<string, unknown>)
      .filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value))
      .map(([id, value]) => ({ id, ...(value as Record<string, unknown>) }))
  }
  return []
}

export interface DiscoverDiff {
  /** 上游有、草稿没有的模型（上游内按 id 去重，缺 id 的丢弃）。 */
  missing: DraftModel[]
  /** 草稿里已有的模型 id（用于行内打「已存在」标记）。 */
  existingIds: Set<string>
}

export function diffDiscovered(discovered: DraftModel[], draft: DraftModel[]): DiscoverDiff {
  const existingIds = new Set(draft.map(modelIdOf).filter(Boolean))
  const seen = new Set<string>()
  const missing: DraftModel[] = []
  for (const model of discovered) {
    const id = modelIdOf(model)
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (!existingIds.has(id)) missing.push(model)
  }
  return { missing, existingIds }
}

export function filterModels(models: DraftModel[], query: string): DraftModel[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return models
  return models.filter(
    (model) =>
      modelIdOf(model).toLowerCase().includes(needle) ||
      (typeof model.name === 'string' && model.name.toLowerCase().includes(needle)),
  )
}

/** 把一个模型追加进草稿条目的 models 数组（对象映射形态会规整成数组）。 */
export function appendModelToEntry(entry: DraftModel, model: DraftModel): DraftModel {
  return { ...entry, models: [...modelsOf(entry), { ...model }] }
}

/** 删掉草稿 models 数组里的一项（对象映射形态同样规整成数组）。 */
export function removeModelFromEntry(entry: DraftModel, index: number): DraftModel {
  const current = modelsOf(entry)
  if (index < 0 || index >= current.length) return entry
  return { ...entry, models: current.filter((_, i) => i !== index) }
}
