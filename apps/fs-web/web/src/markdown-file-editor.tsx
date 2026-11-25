import { useEffect, useRef } from 'react'
import type { EditorView } from 'prosemirror-view'
import { createEditorView } from './markdown-editor.ts'

interface MarkdownEditorProps {
  /** 初始 Markdown；value 后续变化由编辑器自身维护，不外部受控。 */
  value: string
  onChange: (markdown: string) => void
}

/** 把 ProseMirror 视图包成挂载时创建、卸载时销毁的 React 组件（todo-web 同款）。 */
export default function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view: EditorView = createEditorView(host, {
      value,
      onChange: (markdown) => onChangeRef.current(markdown),
    })
    return () => view.destroy()
    // 只在挂载时创建视图；切换文件由外层 key 重挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="wsx-md-editor" ref={hostRef} />
}
