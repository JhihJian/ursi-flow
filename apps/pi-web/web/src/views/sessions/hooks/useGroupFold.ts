import { useCallback, useMemo, useRef, useState } from 'react'
import { defaultFoldedGroups, type SessionGroup } from '../lib/format'

/** 每个项目组默认显示这么多条会话，「显示更多」一次再放 20 条。 */
export const GROUP_VISIBLE = 8
export const SHOW_MORE_STEP = 20

/**
 * 项目组的折叠与「显示更多」。
 *
 * 两组状态都按项目键记，换根目录时整份清空：同一个项目可能出现在两个根下，
 * 在一处折叠过不该带到另一处。清空在渲染期比对 scope 完成，首帧就是新目录的默认样子。
 */
export function useGroupFold(
  groups: readonly SessionGroup[],
  selectedId: string | null,
  scope: string | null,
) {
  // 用户点过的组记在这里；没记的组按默认规则（只有选中会话所在的组展开）。
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [more, setMore] = useState<Record<string, number>>({})
  const lastScope = useRef(scope)
  if (lastScope.current !== scope) {
    lastScope.current = scope
    // 换了目录：直接改 state 的起始值，这一帧就不再沿用旧目录的记录。
    setFolded({})
    setMore({})
  }
  const foldedByDefault = useMemo(() => defaultFoldedGroups(groups, selectedId), [groups, selectedId])

  const toggleGroup = useCallback((key: string) => {
    setFolded((current) => {
      const next = !(current[key] ?? foldedByDefault.has(key))
      return { ...current, [key]: next }
    })
  }, [foldedByDefault])

  const showMore = useCallback((key: string) => {
    setMore((current) => ({ ...current, [key]: (current[key] ?? 0) + SHOW_MORE_STEP }))
  }, [])

  const collapseMore = useCallback((key: string) => {
    setMore((current) => ({ ...current, [key]: 0 }))
  }, [])

  return {
    isFolded: (key: string) => folded[key] ?? foldedByDefault.has(key),
    visibleCount: (key: string) => GROUP_VISIBLE + (more[key] ?? 0),
    toggleGroup,
    showMore,
    collapseMore,
  }
}
