import type { ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm'
import { terminalMinimumContrastRatio, terminalTheme } from './theme'

/** 历史行数：足够回溯编译输出，又不至于让浏览器内存无上限增长。 */
export const TERMINAL_SCROLLBACK_ROWS = 5000

/**
 * 字体族兜底值，正常情况下由 module.css 的 --ssh-font-mono 提供同一份字体链，
 * 这里只在取不到变量（例如页面被单独嵌入、样式未加载）时使用。
 */
export const TERMINAL_FONT_FALLBACK =
  '"SF Mono", "Menlo", "Monaco", "DejaVu Sans Mono", "Liberation Mono", monospace'

/** 终端字号与页面正文字号一致，行高略松于 xterm 默认，读长输出不挤。 */
const TERMINAL_FONT_SIZE = 13
const TERMINAL_LINE_HEIGHT = 1.4

/**
 * xterm 初始化选项。字体沿用页面的 --ssh-font-mono（同一款等宽字体、同一字号），
 * 字重回到 400，让终端文字与页面正文同级，不再比周围重一号；
 * 其余取值对齐 orca 的 buildDefaultTerminalOptions（粗体用亮色、可控滚动、窄滑条）。
 */
export function buildTerminalOptions(
  light: boolean,
  fontFamily: string,
): ITerminalOptions & ITerminalInitOnlyOptions {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    drawBoldTextInBrightColors: true,
    fastScrollSensitivity: 5,
    fontFamily,
    fontSize: TERMINAL_FONT_SIZE,
    fontWeight: '400',
    fontWeightBold: '700',
    lineHeight: TERMINAL_LINE_HEIGHT,
    macOptionClickForcesSelection: true,
    macOptionIsMeta: false,
    minimumContrastRatio: terminalMinimumContrastRatio(light),
    overviewRuler: { width: 8, showTopBorder: false, showBottomBorder: false },
    scrollback: TERMINAL_SCROLLBACK_ROWS,
    scrollOnUserInput: true,
    scrollSensitivity: 1.15,
    theme: terminalTheme(light),
  }
}
