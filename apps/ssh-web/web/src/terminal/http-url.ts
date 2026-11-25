import {
  IPV6_HTTP_HOST_SOURCE,
  isProseUrlTerminator,
  PROSE_HTTP_URL_SOURCE,
} from './prose-url'

/**
 * 移植自 orca 的 shared/terminal/links/terminal-http-url-extraction.ts。
 * 除了 xterm 自带的正则，这里还会按字符扫一遍链接，用来把跨行折断的 URL 拼回去。
 */

const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

const IPV6_HTTP_AUTHORITY = new RegExp(String.raw`^https?:\/\/${IPV6_HTTP_HOST_SOURCE}`, 'iu')

export const TERMINAL_HTTP_URL_REGEX = new RegExp(PROSE_HTTP_URL_SOURCE, 'iu')

export interface ParsedHttpLink {
  url: string
  startIndex: number
  endIndex: number
}

export function extractTerminalHttpLinks(lineText: string): ParsedHttpLink[] {
  const links: ParsedHttpLink[] = []
  for (const candidate of iterateCandidates(lineText)) {
    let parsed: URL
    try {
      parsed = new URL(candidate.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    links.push({
      url: parsed.toString(),
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
    })
  }
  return links
}

function* iterateCandidates(
  lineText: string,
): Generator<{ url: string; startIndex: number; endIndex: number }> {
  let searchStart = 0
  while (searchStart < lineText.length) {
    const startIndex = findNextSchemeIndex(lineText, searchStart)
    if (startIndex === -1) return
    if (!hasWordBoundary(lineText, startIndex)) {
      searchStart = startIndex + 1
      continue
    }
    const rawEndIndex = findCandidateEnd(lineText, startIndex)
    const endIndex = trimTrailingPunctuation(lineText, startIndex, rawEndIndex)
    searchStart = Math.max(rawEndIndex, startIndex + 1)
    if (endIndex <= startIndex || rawEndIndex - startIndex > TERMINAL_HTTP_URL_MAX_LENGTH) continue
    yield { url: lineText.slice(startIndex, endIndex), startIndex, endIndex }
  }
}

function findNextSchemeIndex(lineText: string, searchStart: number): number {
  const relativeIndex = lineText.slice(searchStart).search(/https?:\/\//i)
  return relativeIndex === -1 ? -1 : searchStart + relativeIndex
}

function hasWordBoundary(lineText: string, startIndex: number): boolean {
  return startIndex === 0 || !isAsciiWordCode(lineText.charCodeAt(startIndex - 1))
}

function findCandidateEnd(lineText: string, startIndex: number): number {
  const scanEnd = Math.min(lineText.length, startIndex + TERMINAL_HTTP_URL_MAX_LENGTH + 1)
  for (let index = startIndex; index < scanEnd; index += 1) {
    if (isBodyTerminator(lineText.charCodeAt(index))) return index
  }
  return scanEnd
}

function trimTrailingPunctuation(lineText: string, startIndex: number, rawEndIndex: number): number {
  const minEndIndex =
    startIndex +
    (IPV6_HTTP_AUTHORITY.exec(lineText.slice(startIndex, rawEndIndex))?.[0].length ?? 0)
  let endIndex = rawEndIndex
  while (endIndex > minEndIndex && isTrailingPunctuation(lineText.charCodeAt(endIndex - 1))) {
    endIndex -= 1
  }
  return endIndex
}

function isBodyTerminator(code: number): boolean {
  return (
    (code > 0x7f && isProseUrlTerminator(String.fromCharCode(code))) ||
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x21 ||
    code === 0x2a ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isTrailingPunctuation(code: number): boolean {
  return (
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x3a ||
    code === 0x2c ||
    code === 0x2e ||
    code === 0x21 ||
    code === 0x3f ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x7e ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}
