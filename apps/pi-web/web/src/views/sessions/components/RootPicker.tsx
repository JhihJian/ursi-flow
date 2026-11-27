import { useCallback } from 'react'
import { DirBrowser } from '@ursi/directory-picker'
import type { ListDirFn } from '@ursi/directory-picker'
import type { BrowseResult } from '../api'
import { useSessionsController } from '../sessions-context'

interface RootPickerProps {
  root: string
  defaultRoot: string
  suggestedRoots: string[]
  onPick: (root: string) => void
  onClose: () => void
}

/**
 * 选根面板：输入绝对路径直接打开，或在目录树里逐级进入。
 * 只列出子目录与各自直接包含的 `.jsonl` 数量，用来判断哪一层才是会话目录。
 *
 * 浏览与竞态处理复用 @ursi/directory-picker 的 DirBrowser；
 * 会话数经 entries 的 note 标注展示，服务端按会话数排序的顺序原样保留。
 *
 * 在工作区内就地渲染（不做全屏浮层）：多区域布局里浮层一盖就是整个工作区，
 * 而且 position: fixed 在外壳的 portal 结构下坐标并不可靠。
 */
export function RootPicker({
  root,
  defaultRoot,
  suggestedRoots,
  onPick,
  onClose,
}: RootPickerProps) {
  const { api } = useSessionsController()

  const listDir = useCallback<ListDirFn>(
    async (target) => {
      const next: BrowseResult = await api.fetchBrowse(target)
      return {
        path: next.path,
        parent: next.parent,
        entries: next.dirs.map((dir) => ({
          name: dir.name,
          note: dir.sessions > 0 ? `${dir.sessions} 个会话` : undefined,
        })),
      }
    },
    [api],
  )

  return (
    <div className="picker" role="group" aria-label="选择会话目录">
      <div className="picker-head">
        <h2 className="picker-title">选择会话目录</h2>
        <button type="button" className="rail-toggle" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="picker-body">
        <DirBrowser
          listDir={listDir}
          initialPath={root || defaultRoot || '~'}
          onSelect={onPick}
          onCancel={onClose}
          suggestions={suggestedRoots}
          selectLabel="使用这个目录"
          placeholder="绝对路径回车打开，如 ~/.pi/agent/sessions"
        />
      </div>
    </div>
  )
}
