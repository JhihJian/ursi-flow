import { cn } from '@/shared/lib/utils'

import type { MarkdownViewMode } from './use-explorer'

const modes: Array<{ value: MarkdownViewMode; label: string }> = [
  { value: 'edit', label: '编辑' },
  { value: 'split', label: '分栏' },
  { value: 'preview', label: '预览' },
]

/** Markdown 的三档视图切换，供桌面工具栏与窄屏编辑工具栏共用。 */
export function MarkdownViewToggle({ value, onChange }: { value: MarkdownViewMode; onChange: (mode: MarkdownViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-elevated p-0.5" role="radiogroup" aria-label="Markdown 视图">
      {modes.map(mode => (
        <button
          key={mode.value}
          type="button"
          role="radio"
          aria-checked={value === mode.value}
          data-testid={`md-view-${mode.value}`}
          className={cn(
            'rounded px-2 py-0.5 text-[12px] leading-5 transition-colors',
            value === mode.value ? 'bg-surface text-txt shadow-sm' : 'text-txt3 hover:text-txt2',
          )}
          onClick={() => onChange(mode.value)}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}
