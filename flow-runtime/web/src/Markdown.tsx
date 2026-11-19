// Markdown 视图：marked 渲染，mermaid 代码块就地绘制成图，DOMPurify 清洗结果。
import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { Eye, Pencil } from 'lucide-react'

marked.setOptions({ gfm: true, breaks: false })

// mermaid 体积较大，只在真正需要绘图时加载。
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
async function prepareMermaid() {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: 'inherit',
      themeVariables: {
        background: 'rgb(255 255 255)',
        primaryColor: 'rgb(240 237 255)',
        primaryTextColor: 'rgb(24 24 27)',
        primaryBorderColor: 'rgb(123 97 255)',
        lineColor: 'rgb(120 120 132)',
        secondaryColor: 'rgb(244 244 245)',
        tertiaryColor: 'rgb(250 250 251)',
      },
    })
    return mermaid
  })
  return mermaidReady
}

/** 把正文中的 mermaid 代码块渲染成 SVG，失败时保留原文并提示。 */
async function renderDiagrams(root: HTMLElement) {
  const mermaid = await prepareMermaid()
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')]
  for (const [index, code] of blocks.entries()) {
    const source = code.textContent ?? ''
    const holder = document.createElement('div')
    holder.className = 'mermaid-figure'
    try {
      const { svg } = await mermaid.render(`mermaid-${Date.now()}-${index}`, source)
      holder.innerHTML = svg
    } catch {
      holder.className = 'mermaid-figure is-error'
      holder.textContent = '这段 Mermaid 图无法渲染，请检查语法。'
    }
    code.parentElement?.replaceWith(holder)
  }
}

export function Markdown({
  text,
  onOpenFile,
  path = '',
  className = '',
}: {
  text: string
  onOpenFile?: (path: string) => void
  /** 当前文件路径，用于解析包内相对链接。 */
  path?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { meta, body } = useMemo(() => splitFrontmatter(text), [text])
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(body, { async: false }) as string, {
        ADD_ATTR: ['target'],
      }),
    [body],
  )
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let cancelled = false
    void renderDiagrams(root).then(() => {
      if (!cancelled) root.dataset.rendered = 'true'
    })
    return () => {
      cancelled = true
    }
  }, [html])
  return (
    <div
      ref={ref}
      className={'md ' + className}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a')
        if (!anchor || !onOpenFile) return
        const href = anchor.getAttribute('href') ?? ''
        // 只接管包内相对链接，外部链接保持浏览器默认行为。
        if (!href || /^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return
        event.preventDefault()
        onOpenFile(resolveRelative(path, href))
      }}
    >
      {meta.length > 0 && (
        <dl className="md-meta">
          {meta.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className={value.includes('\n') ? 'is-block' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

/** 按当前文件所在目录解析包内相对路径。 */
function resolveRelative(path: string, href: string): string {
  const target = decodeURIComponent(href.split('#')[0])
  const base = path.split('/').slice(0, -1)
  const parts = target.startsWith('/') ? [] : [...base]
  for (const segment of target.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/** 拆出 YAML 元信息，直接交给 Markdown 渲染会把 `---` 当成标题下划线。 */
function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return { meta: [], body: text }
  const meta: [string, string][] = []
  let key = ''
  for (const line of match[1].split(/\r?\n/)) {
    // 顶层键单独成项；嵌套内容（如 variables）保留缩进与换行，按原样逐行展示。
    const pair = line.match(/^([\w-]+):[ \t]*(.*)$/)
    if (pair) {
      key = pair[1]
      meta.push([key, pair[2]])
    } else if (key && line.trim()) {
      const [last] = meta.slice(-1)
      last[1] = last[1] ? `${last[1]}\n${line.trimEnd()}` : line.trimEnd()
    }
  }
  return { meta, body: text.slice(match[0].length) }
}

/** Markdown 编辑器：宽屏左右分栏，窄屏用标签切换编辑与预览。 */
export function MarkdownEditor({
  value,
  onChange,
  onOpenFile,
  path,
}: {
  value: string
  onChange: (next: string) => void
  onOpenFile?: (path: string) => void
  path?: string
}) {
  const [mode, setMode] = useState<'split' | 'edit' | 'preview'>('split')
  return (
    <div className={'md-editor mode-' + mode}>
      <div className="md-editor-bar">
        <div role="tablist" aria-label="编辑方式">
          <button role="tab" aria-selected={mode === 'edit'} onClick={() => setMode('edit')}>
            <Pencil size={13} />
            编辑
          </button>
          <button role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}>
            <Eye size={13} />
            预览
          </button>
          <button role="tab" aria-selected={mode === 'split'} onClick={() => setMode('split')}>
            分栏
          </button>
        </div>
      </div>
      <div className="md-editor-body">
        {mode !== 'preview' && (
          <textarea
            className="code md-source"
            aria-label="Markdown 源码"
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {mode !== 'edit' && (
          <div className="md-preview">
            <Markdown text={value} onOpenFile={onOpenFile} path={path} />
          </div>
        )}
      </div>
    </div>
  )
}
