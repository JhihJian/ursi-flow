import { useEffect, useRef } from 'react'
import type { EditorView } from 'prosemirror-view'
import { createEditorView } from '@/lib/markdown-editor'

interface MarkdownEditorProps {
  /** 初始 Markdown；切换任务时由外部 key 触发重挂载。 */
  value: string
  placeholder: string
  onChange: (markdown: string) => void
}

/** 把 ProseMirror 视图包成受控外观的 React 组件。 */
export default function MarkdownEditor({ value, placeholder, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view: EditorView = createEditorView(host, {
      value,
      placeholder,
      onChange: (markdown) => onChangeRef.current(markdown),
    })
    return () => view.destroy()
    // 只在挂载时创建视图，value 的后续变化由编辑器自身维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="markdown-editor" ref={hostRef} />
}
