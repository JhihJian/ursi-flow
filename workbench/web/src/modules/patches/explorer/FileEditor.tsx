import { cn } from '@/shared/lib/utils'
import { Icon } from '@/shared/ui/icon'
import { MarkdownContent } from '@/shared/ui/markdown-content'

import { EditorStatusBar } from './ExplorerTabs'
import { MarkdownViewToggle } from './MarkdownViewToggle'
import { formatBytes, isMarkdownPath, languageOf } from './paths'
import type { MarkdownViewMode, OpenDoc } from './use-explorer'

export interface FileEditorProps {
  doc: OpenDoc | null
  viewMode: MarkdownViewMode
  compact: boolean
  stats: { language: string; lines: number; characters: number; size: string } | null
  onChange: (path: string, text: string) => void
  onRetry: (path: string) => void
  onDownload: (path: string) => void
}

const textareaClass = 'scroll-area min-h-0 w-full flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-txt outline-none'

/**
 * 文件编辑区：Markdown 支持编辑/分栏/预览，其他文本用等宽文本框，
 * 二进制文件只展示大小与下载入口，绝不当作文本覆写。
 */
export function FileEditor({ doc, viewMode, compact, stats, onChange, onRetry, onDownload }: FileEditorProps) {
  if (!doc) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-txt3">
        <Icon name="doc" size={28} className="text-line-strong" />
        从文件树选择文件，或新建文件开始编辑。
      </div>
    )
  }

  if (doc.loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-txt3">正在读取 {doc.path}…</div>
  }

  if (doc.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <p className="break-words text-sm text-err">{doc.error}</p>
        <button type="button" className="text-sm text-accent-2 underline" onClick={() => onRetry(doc.path)}>
          重新读取
        </button>
      </div>
    )
  }

  if (doc.binary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="doc" size={28} className="text-line-strong" />
        <p className="break-all font-mono text-[12px] text-txt2">{doc.path}</p>
        <p className="text-sm text-txt3">二进制文件共 {formatBytes(doc.size)}，不能当文本编辑。</p>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-txt hover:bg-elevated"
          onClick={() => onDownload(doc.path)}
        >
          <Icon name="download" size={14} />下载文件
        </button>
      </div>
    )
  }

  const markdown = isMarkdownPath(doc.path)
  const mode = compact && viewMode === 'split' ? 'edit' : viewMode
  const editor = (
    <textarea
      aria-label={`${doc.path} 内容`}
      className={textareaClass}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      value={doc.text}
      onChange={event => onChange(doc.path, event.target.value)}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {markdown && mode === 'split' ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-line">
          {editor}
          <div className="scroll-area min-h-0 overflow-y-auto p-4">
            <MarkdownContent content={doc.text} />
          </div>
        </div>
      ) : markdown && mode === 'preview' ? (
        <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-4">
          <MarkdownContent content={doc.text} />
        </div>
      ) : (
        editor
      )}
      <EditorStatusBar doc={doc} stats={stats ?? { language: languageOf(doc.path), lines: doc.text.split('\n').length, characters: doc.text.length, size: formatBytes(doc.size) }} />
    </div>
  )
}

export interface CompactEditorHeaderProps {
  path: string
  dirty: boolean
  saving: boolean
  markdown: boolean
  viewMode: MarkdownViewMode
  onBack: () => void
  onSave: () => void
  onViewMode: (mode: MarkdownViewMode) => void
}

/** 窄屏编辑头部：返回列表、当前路径与保存，替代桌面标签栏。 */
export function CompactEditorHeader(props: CompactEditorHeaderProps) {
  const mode = props.viewMode === 'split' ? 'edit' : props.viewMode
  return (
    <div className="flex shrink-0 flex-col border-b border-line/60">
      <div className="flex min-h-12 items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-[12px] text-txt2 hover:text-txt"
          onClick={props.onBack}
        >
          <Icon name="chevron-left" size={14} />返回
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-txt" title={props.path}>
          {props.path}
          {props.dirty && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-label="未保存" />}
        </span>
        <button
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded px-2 text-[12px] text-accent-2 disabled:opacity-40"
          disabled={!props.dirty || props.saving}
          onClick={props.onSave}
        >
          <Icon name="save" size={14} />{props.saving ? '保存中' : '保存'}
        </button>
      </div>
      {props.markdown && (
        <div className="flex items-center justify-end px-3 pb-2">
          <MarkdownViewToggle value={mode} onChange={props.onViewMode} />
        </div>
      )}
    </div>
  )
}

export interface DesktopEditorToolbarProps {
  markdown: boolean
  viewMode: MarkdownViewMode
  dirty: boolean
  saving: boolean
  onSave: () => void
  onViewMode: (mode: MarkdownViewMode) => void
}

/** 桌面编辑工具栏右侧：Markdown 视图切换与保存。 */
export function EditorToolbarActions(props: DesktopEditorToolbarProps) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2 px-2')}>
      {props.markdown && <MarkdownViewToggle value={props.viewMode} onChange={props.onViewMode} />}
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-txt3 transition-colors hover:bg-elevated hover:text-txt disabled:opacity-40"
        title="保存（Ctrl+S）"
        disabled={!props.dirty || props.saving}
        onClick={props.onSave}
      >
        <Icon name="save" size={13} />{props.saving ? '保存中' : '保存'}
      </button>
    </div>
  )
}
