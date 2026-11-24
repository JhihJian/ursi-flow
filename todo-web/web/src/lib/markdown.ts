/**
 * 小型 Markdown 渲染，覆盖任务备注常用的写法。
 * 先转义 HTML，再按块和行内规则生成标签，因此输入里的原始 HTML 只会作为文本显示。
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char)
}

function renderInline(text: string): string {
  const codes: string[] = []
  let output = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })

  output = output
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )

  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)]}</code>`)
}

function renderList(lines: string[], ordered: boolean): string {
  const pattern = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/
  const items = lines.map((line) => {
    const match = line.match(pattern)
    return `<li>${renderInline(match ? match[1] : line.trim())}</li>`
  })
  return ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.trim().startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push('<hr />')
      index += 1
      continue
    }

    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length && lines[index].startsWith('>')) {
        quoted.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`)
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index])
        index += 1
      }
      blocks.push(renderList(items, true))
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index])
        index += 1
      }
      blocks.push(renderList(items, false))
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6}\s|>|```|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[index]) &&
      !/^\s*(?:---+|\*\*\*+)\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
  }

  return blocks.join('\n')
}
