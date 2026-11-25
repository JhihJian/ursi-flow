import type { ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm'
import { terminalMinimumContrastRatio, terminalTheme } from './theme'

/** 历史行数：足够回溯编译输出，又不至于让浏览器内存无上限增长。 */
export const TERMINAL_SCROLLBACK_ROWS = 5000

/**
 * 字体链沿用 orca 的跨平台 mono 组合：优先系统等宽，再退到常见的 Nerd Font，
 * 保证 tmux 状态栏和 CLI 图标不出现豆腐块。
 */
const TERMINAL_FONT_FAMILY =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

/**
 * xterm 初始化选项。取值对齐 orca 的 buildDefaultTerminalOptions：
 * 粗体用亮色、Option 键可组合字符、粗滚动、Ctrl+滚轮加速，
 * 滚动条走 overviewRuler 的窄宽度（xterm 6 的滑条宽度由它决定）。
 */
export function buildTerminalOptions(light: boolean): ITerminalOptions & ITerminalInitOnlyOptions {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    drawBoldTextInBrightColors: true,
    fastScrollSensitivity: 5,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 14,
    fontWeight: '500',
    fontWeightBold: '700',
    lineHeight: 1.2,
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
