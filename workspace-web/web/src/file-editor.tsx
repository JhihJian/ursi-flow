import { useEffect } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

// 契约：编辑器必须本地打包，禁 CDN（内网不可达）。
loader.config({ monaco })

// Vite 会把 worker 打成独立 chunk；MonacoEnvironment 指向同包 worker。
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const languageMap: Record<string, Promise<unknown>> = {
      css: import('monaco-editor/esm/vs/language/css/css.worker?worker'),
      html: import('monaco-editor/esm/vs/language/html/html.worker?worker'),
      typescript: import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      javascript: import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      json: import('monaco-editor/esm/vs/language/json/json.worker?worker'),
    }
    return (languageMap[label] ?? import('monaco-editor/esm/vs/editor/editor.worker?worker')) as never
  },
}

export interface FileEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  pathLabel: string
}

/** 文件编辑器：Monaco 本地包，只渲染已读入的文本。 */
export default function FileEditor({ value, onChange, onSave, pathLabel }: FileEditorProps) {
  // Ctrl/Cmd+S 阻止浏览器默认行为。
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        onSave()
      }
      return
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onSave])

  const language = languageOf(pathLabel)
  return (
    <Editor
      value={value}
      language={language}
      theme="vs"
      onChange={(next) => onChange(next ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  )
}

function languageOf(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    sh: 'shell',
    py: 'python',
    rs: 'rust',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
  }
  return map[ext ?? '']
}
