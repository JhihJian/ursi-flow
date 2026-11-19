'use client'

import { useMemo } from 'react'
import { Marked } from 'marked'
import DOMPurify, { type Config } from 'dompurify'

const SANITIZE_OPTIONS: Config = {
  ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
}

const markdown = new Marked()

/**
 * 净化的结果是可信 DOM 片段，标题降级只在这里搬运节点：
 * 预览标题整体降一级（文档标题属于被预览的内容，不应产生页面级 h1），
 * 一级标题降为 h2 后用 `.markdown-title` 保留原视觉尺寸。
 */
function demoteHeadings(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // 先取出全部标题再逐个替换，避免刚生成的标题被重复降级。
  for (const heading of Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, h5'))) {
    const level = Number(heading.tagName.slice(1))
    const demoted = doc.createElement(`h${level + 1}`)
    if (level === 1) demoted.className = 'markdown-title'
    demoted.append(...Array.from(heading.childNodes))
    heading.replaceWith(demoted)
  }
  return doc.body.innerHTML
}

export interface MarkdownContentProps {
  content: string
  className?: string
}

/** Markdown 预览：marked 解析后经 DOMPurify 净化，只允许排版所需标签与属性。 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const html = useMemo(() => demoteHeadings(DOMPurify.sanitize(markdown.parse(content, { async: false }), SANITIZE_OPTIONS)), [content])
  return <div className={className ? `markdown-content ${className}` : 'markdown-content'} dangerouslySetInnerHTML={{ __html: html }} />
}
