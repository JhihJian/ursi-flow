import { useEffect, useState } from 'react'
import type { Directory } from '../api'
import { cn } from '@/shared/lib/utils'
import { MarkdownContent } from '@/shared/ui/markdown-content'
import { ResourceState } from '@/shared/ui/resource-state'
import { PROMPT_PATH } from './model'
import { FileError } from './FileError'
import { SaveBar } from './SaveBar'
import { useTextFile } from './use-text-file'

type ViewMode = 'edit' | 'split' | 'preview'

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分栏' },
  { id: 'preview', label: '预览' },
]

/**
 * 系统提示词：`AGENTS.md` 的查看与编辑，右侧是 Markdown 预览。
 * 与 `mcp.json` 一样只做文本编辑，不解析 frontmatter 或模型信息。
 */
export function SystemPrompt({ directory, onDirtyChange }: { directory: Directory; onDirtyChange?: (dirty: boolean) => void }) {
  const file = useTextFile(directory, PROMPT_PATH)
  const [mode, setMode] = useState<ViewMode>('split')

  useEffect(() => { onDirtyChange?.(file.dirty) }, [file.dirty, onDirtyChange])

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-1 pb-2">
      <span className="font-mono text-xs text-txt2">{PROMPT_PATH}</span>
      <div role="group" aria-label="视图" className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
        {VIEW_MODES.map(item => <button
          key={item.id}
          type="button"
          aria-pressed={mode === item.id}
          className={cn(
            'h-6 rounded px-2 text-[11px] transition-colors',
            mode === item.id ? 'bg-accent-dim text-accent-2' : 'text-txt3 hover:text-txt2',
          )}
          onClick={() => setMode(item.id)}
        >{item.label}</button>)}
      </div>
      <SaveBar file={file} />
    </div>
    {file.error ? <FileError message={file.error} onRetry={file.reload} /> : null}
    {!file.error && file.loading
      ? <ResourceState loading className="rounded-none border-0 shadow-none" />
      : <div className={cn('grid min-h-0 flex-1 gap-3 pt-2', mode === 'split' ? 'grid-rows-2 lg:grid-cols-2 lg:grid-rows-1' : 'grid-cols-1')}>
        {mode !== 'preview' && <div className="flex min-h-0 min-w-0 flex-col">
          <textarea
            className="textarea min-h-0 flex-1 resize-none font-mono text-[13px] leading-6"
            aria-label="AGENTS.md 内容"
            spellCheck={false}
            value={file.text}
            onChange={event => file.change(event.target.value)}
          />
        </div>}
        {mode !== 'edit' && <div className="scroll-area min-h-40 min-w-0 overflow-auto rounded-lg border border-line bg-surface px-4 py-3">
          <MarkdownContent content={file.text} />
        </div>}
      </div>}
  </div>
}
