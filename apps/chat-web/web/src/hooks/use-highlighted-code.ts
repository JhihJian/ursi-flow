import * as React from 'react'

import { loadHighlighter } from '@/lib/highlighter'

export function useHighlightedCode(value: string, language: string) {
  // 结尾换行会渲染成多余的空行。
  const code = value.endsWith('\n') ? value.slice(0, -1) : value
  const [loaded, setLoaded] = React.useState<{
    language: string
    highlighter: Awaited<ReturnType<typeof loadHighlighter>>
  } | null>(null)
  const highlighter = loaded?.language === language ? loaded.highlighter : null

  React.useEffect(() => {
    let cancelled = false

    loadHighlighter(language)
      .then((next) => {
        if (!cancelled) {
          setLoaded({ language, highlighter: next })
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [language])

  // 已完成的完整行。代码流式到达时，只对新增行 tokenize，
  // 从上一行的语法状态继续。
  const [done, setDone] = React.useState<{
    highlighter: typeof highlighter
    text: string
    lines: React.ReactNode[]
    state?: Parameters<NonNullable<typeof highlighter>['highlight']>[1]
  }>({ highlighter: null, text: '', lines: [] })

  let next = done

  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, text: '', lines: [] }
  }

  const end = code.lastIndexOf('\n') + 1

  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(
      code.slice(next.text.length, end - 1),
      next.state,
    )

    next = {
      highlighter,
      text: code.slice(0, end),
      lines: [...next.lines, ...result.lines],
      state: result.state,
    }
  }

  if (next !== done) {
    setDone(next)
  }

  // 最后一行仍在写入，每次渲染时重新 tokenize。
  const tail = code.slice(end)

  return React.useMemo(() => {
    if (!highlighter) {
      return code.split('\n')
    }

    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]]
  }, [code, highlighter, next, tail])
}
