import type { ResourceRef } from '@/shared/api/work-patch-generators'

/** 只提交当前修订声明的别名，且保持声明顺序。 */
export function resolveInputs(aliases: string[], refs: ResourceRef[]): ResourceRef[] | null {
  const ordered = aliases.map(alias => refs.find(ref => ref.alias === alias && ref.serverId && ref.uri))
  return ordered.every(ref => ref !== undefined) ? ordered : null
}
