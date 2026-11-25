import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { extractTerminalHttpLinks } from './http-url'

/**
 * 链接层移植自 orca 的 terminal-pane/links：
 * - 用同一套解析（含中文句读与句末标点处理）同时覆盖单行与跨行折断的 URL；
 * - 悬停显示完整 URL 与打开方式提示，⌘/Ctrl+点击打开新标签页。
 * 跨行是这里的关键：xterm 自带的 web-links 只看单行，长 URL 被折断后无法点击。
 */

const MAX_WRAPPED_ROWS = 200
const MAX_WRAPPED_CHARS = 20_000

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

export function terminalLinkHint(): string {
  return isMacPlatform() ? '⌘+点击打开' : 'Ctrl+点击打开'
}

export function openExternalUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export interface LinkTooltip {
  show(url: string): void
  hide(): void
}

/** 链接悬停提示条：定位在终端面板左下角，与 orca 的 pane-link-tooltip 一致。 */
export function createLinkTooltip(element: HTMLElement): LinkTooltip {
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let hoverToken = 0
  const hide = (): void => {
    hoverToken += 1
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    element.style.display = 'none'
  }
  return {
    show(url: string) {
      hoverToken += 1
      const token = hoverToken
      if (hideTimer) clearTimeout(hideTimer)
      element.textContent = `${url} (${terminalLinkHint()})`
      element.style.display = ''
      // 鼠标停在链接上但终端继续输出时不会再触发 hover，兜底隐藏避免提示条常驻。
      hideTimer = setTimeout(() => {
        if (token === hoverToken) hide()
      }, 15_000)
    },
    hide,
  }
}

interface LogicalRow {
  /** 1-based 缓冲区行号。 */
  y: number
  text: string
  /** 每个字符所在列（0-based），末尾多一个结束列。 */
  columns: number[]
  startIndex: number
}

function readRow(line: IBufferLine): { text: string; columns: number[] } {
  let text = ''
  const columns: number[] = []
  let endColumn = 0
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x)
    if (!cell) break
    const width = cell.getWidth()
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    text += chars
    for (let index = 0; index < chars.length; index += 1) columns.push(x)
    endColumn = x + Math.max(width, 1)
  }
  // 末尾哨兵：让半开区间的结束下标也能映射到列。
  columns.push(endColumn)
  return { text, columns }
}

/** 把光标所在行扩展成整条逻辑行（软换行由 xterm 的 isWrapped 标记）。 */
function buildLogicalLine(terminal: Terminal, bufferLineNumber: number): LogicalRow[] | null {
  const buffer = terminal.buffer.active
  const y = bufferLineNumber - 1
  if (!buffer.getLine(y)) return null

  let startY = y
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
    if (y - startY >= MAX_WRAPPED_ROWS) return null
    startY -= 1
  }
  let endY = y
  while (buffer.getLine(endY + 1)?.isWrapped) {
    if (endY - y >= MAX_WRAPPED_ROWS) return null
    endY += 1
  }

  const rows: LogicalRow[] = []
  let textLength = 0
  for (let rowY = startY; rowY <= endY; rowY += 1) {
    const line = buffer.getLine(rowY)
    if (!line) return null
    const { text, columns } = readRow(line)
    if (textLength + text.length > MAX_WRAPPED_CHARS) return null
    rows.push({ y: rowY + 1, text, columns, startIndex: textLength })
    textLength += text.length
  }
  return rows
}

/** 逻辑行内的字符下标 → { 行, 该行内 1-based 列号 }。 */
function toPosition(rows: LogicalRow[], index: number): { row: LogicalRow; x: number } | null {
  for (const row of rows) {
    const rowEnd = row.startIndex + row.text.length
    if (index < row.startIndex || index > rowEnd) continue
    const local = Math.min(index - row.startIndex, row.columns.length - 1)
    return { row, x: (row.columns[local] ?? 0) + 1 }
  }
  return null
}

function lastColumn(row: LogicalRow): number {
  const column = row.columns[Math.max(0, row.text.length - 1)] ?? 0
  return column + 1
}

/**
 * 终端链接提供者：单行与跨行 URL 走同一条解析路径。
 * 对每条被查询的行只返回落在该行内的那一段，xterm 才能正确做命中高亮。
 */
export function createTerminalLinkProvider(terminal: Terminal, tooltip: LinkTooltip): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const rows = buildLogicalLine(terminal, bufferLineNumber)
      if (!rows) {
        callback(undefined)
        return
      }
      const text = rows.map((row) => row.text).join('')
      if (!/https?:\/\//i.test(text)) {
        callback(undefined)
        return
      }
      const current = rows.find((row) => row.y === bufferLineNumber)
      if (!current) {
        callback(undefined)
        return
      }
      const links: ILink[] = []
      for (const parsed of extractTerminalHttpLinks(text)) {
        const start = toPosition(rows, parsed.startIndex)
        const end = toPosition(rows, parsed.endIndex - 1)
        if (!start || !end) continue
        // 只保留落在当前行的那一段：起点之前的行不留链接，终点之后的行同样。
        if (bufferLineNumber < start.row.y || bufferLineNumber > end.row.y) continue
        const x1 = bufferLineNumber === start.row.y ? start.x : 1
        const x2 = bufferLineNumber === end.row.y ? end.x : lastColumn(current)
        if (x2 < x1) continue
        links.push({
          text: parsed.url,
          range: { start: { x: x1, y: bufferLineNumber }, end: { x: x2, y: bufferLineNumber } },
          activate: (event, uri) => {
            // 终端习惯：⌘/Ctrl+点击才打开，普通点击留给选择文本。
            if (!event.metaKey && !event.ctrlKey) return
            event.preventDefault()
            openExternalUrl(uri)
          },
          hover: (_event, uri) => tooltip.show(uri),
          leave: () => tooltip.hide(),
        })
      }
      callback(links.length > 0 ? links : undefined)
    },
  }
}
