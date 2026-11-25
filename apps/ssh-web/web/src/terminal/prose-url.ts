/**
 * 移植自 orca 的 shared/text/prose-url-boundary.ts。
 * 只有括号、引号、空白与句末标点结束 URL；`・`、`–`、`·` 这类标题字符留在 URL 内。
 */
const PROSE_URL_TERMINATOR_SOURCE = String.raw`(?![\0-\x7f])[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Z}\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\uFF1A\uFF1B\uFF61\uFF64\u2026\u2025\u2014]`

const NOT_PROSE_URL_TERMINATOR = `(?!${PROSE_URL_TERMINATOR_SOURCE})`

/** 方括号包住的 IPv6 主机，例如 `user@[::1]`；它的 `]` 不是句末标点。 */
export const IPV6_HTTP_HOST_SOURCE = String.raw`(?:(?:${NOT_PROSE_URL_TERMINATOR}[^\s"'!*(){}|\\^<>\x60\/?#\[\]])*@)?\[[\dA-Fa-f:.]+\]`

const PROSE_HTTP_URL_BODY_SOURCE =
  String.raw`(?:${NOT_PROSE_URL_TERMINATOR}[^\s"'!*(){}|\\^<>\x60])*` +
  String.raw`${NOT_PROSE_URL_TERMINATOR}[^\s"':,.!?{}|\\^~\[\]\x60()<>]`

/** xterm web-links 的 URL 模式，额外被中文句读切断；使用时需要 `iu` 标志。 */
export const PROSE_HTTP_URL_SOURCE = String.raw`https?:\/\/(?:${IPV6_HTTP_HOST_SOURCE}(?:${PROSE_HTTP_URL_BODY_SOURCE})?|${PROSE_HTTP_URL_BODY_SOURCE})`

const PROSE_URL_TERMINATOR = new RegExp(PROSE_URL_TERMINATOR_SOURCE, 'u')

export function isProseUrlTerminator(char: string): boolean {
  return PROSE_URL_TERMINATOR.test(char)
}
