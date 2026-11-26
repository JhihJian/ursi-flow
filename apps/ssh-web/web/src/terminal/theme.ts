import type { ITheme } from '@xterm/xterm'
import { contrastRatio, hexToRgb, over, rgbaString, type Rgba } from './color'

/**
 * 配色取向：终端不是独立的小黑窗，而是出版物版面的延续。
 * 两套主题的 ANSI 调色板都由 achromatic 灰阶 + 六种低饱和「印刷专色」组成，
 * 不出现电商绿、终端蓝这类高纯度色，切换主题时版面观感不跳。
 * 基准对比度：白底正文槽位 ≥5:1，暗底除 black 一档（1.4:1，本来就用于「看不见」的场景，
 * 交给 xterm 的最小对比度门限抬到 3:1）外都 ≥3:1。
 * white / brightWhite 是例外：它们主要被程序当图形色用（`\e[47m` 反显底、块状进度条、
 * tmux 状态栏），这类字形在 xterm 里绕过最小对比度门限，取近白就会在白底上消失，
 * 所以亮色下压到中灰（2:1 以上），反显时的黑字仍有 6:1。
 * 选中色与搜索高亮色刻意不同源：选中是灰阶偏靛的淡染，高亮是纯灰块 + 砖红当前项。
 */

/** 暗色：底色用页面灰阶的 gray-900，前景用 gray-200，与侧栏、标签栏同一套灰。 */
const DARK_THEME: ITheme = {
  background: '#1a1a1a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#2b3c4d',
  selectionForeground: '#f5f5f5',
  black: '#333333',
  red: '#b06060',
  green: '#7f9a6b',
  yellow: '#c2a25e',
  blue: '#7d97b5',
  magenta: '#a8839c',
  cyan: '#7aa5a2',
  white: '#c8c8c8',
  brightBlack: '#6b6b6b',
  brightRed: '#cc8484',
  brightGreen: '#9cb989',
  brightYellow: '#d8bc7e',
  brightBlue: '#9db4cc',
  brightMagenta: '#c2a2b7',
  brightCyan: '#9cc0bd',
  brightWhite: '#eeeeee',
}

/** 亮色：白底黑字，专色压深到 5:1 以上，白底上不糊；白/亮白见文件头例外说明。 */
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#b9cade',
  selectionForeground: '#1a1a1a',
  black: '#2e2e2e',
  red: '#9c3a34',
  green: '#4a6b3f',
  yellow: '#7d6320',
  blue: '#3c5a7d',
  magenta: '#7a4a66',
  cyan: '#2f6260',
  /* 白槽位取中灰：`\e[47m` 反显、块状进度条都要在白底上看得见（见文件头注释）。 */
  white: '#b4b4b4',
  brightBlack: '#6b6b6b',
  brightRed: '#822d28',
  brightGreen: '#3a5530',
  brightYellow: '#664f18',
  brightBlue: '#334c69',
  brightMagenta: '#653c54',
  brightCyan: '#274f4e',
  brightWhite: '#8c8c8c',
}

/**
 * 白底上的白字必须抬到 4.5:1 才可读，深色底只要 3:1 就不会把饱和色洗白。
 * 与 orca 的 LIGHT_BG_MIN_CONTRAST / DARK_BG_MIN_CONTRAST 一致。
 */
const MINIMUM_CONTRAST_RATIO = { dark: 3, light: 4.5 }

const LEGACY_SLIDER_GREY: Rgba = [180, 180, 185, 1]

/**
 * 滚动条滑块的透明度下限：固定灰在亮色主题上会消失，而固定 alpha 在 Solarized 这类
 * 低对比前景上又会糊掉，所以按前景色的实际对比度抬到旧灰的比例。取自 orca。
 */
function sliderAlpha(foreground: Rgba, background: Rgba, alpha: number, greyAlpha: number): number {
  const contrastAt = ([r, g, b]: Rgba, a: number): number =>
    contrastRatio(over([r, g, b, a], background), background)
  const floor = contrastAt(LEGACY_SLIDER_GREY, greyAlpha)
  let next = alpha
  while (next < 1 && contrastAt(foreground, next) < floor) {
    next = Math.round(next * 100 + 1) / 100
  }
  return next
}

/** 用前景色给滚动条染色，避免亮色主题上出现一条看不见的灰条。 */
function scrollbarColors(foreground: string, background: string): Pick<
  ITheme,
  'scrollbarSliderBackground' | 'scrollbarSliderHoverBackground' | 'scrollbarSliderActiveBackground'
> | null {
  const fg = hexToRgb(foreground)
  const bg = hexToRgb(background)
  if (!fg || !bg) return null
  const tint = (alpha: number, greyAlpha: number) =>
    rgbaString(fg, sliderAlpha(fg, bg, alpha, greyAlpha))
  return {
    scrollbarSliderBackground: tint(0.35, 0.4),
    scrollbarSliderHoverBackground: tint(0.55, 0.6),
    scrollbarSliderActiveBackground: tint(0.7, 0.8),
  }
}

/** 终端主题：底色 + ANSI 调色板 + 滚动条染色，overview ruler 边框透明避免亮线。 */
export function terminalTheme(light: boolean): ITheme {
  const base = light ? LIGHT_THEME : DARK_THEME
  const scrollbar =
    base.foreground && base.background
      ? scrollbarColors(base.foreground, base.background)
      : null
  return {
    // 透明边框：overviewRuler 一旦开宽度就会画边线，亮色主题上会是一条亮线。
    overviewRulerBorder: 'transparent',
    ...base,
    ...scrollbar,
  }
}

export function terminalMinimumContrastRatio(light: boolean): number {
  return light ? MINIMUM_CONTRAST_RATIO.light : MINIMUM_CONTRAST_RATIO.dark
}

/** 终端面板底色，React 侧用它同步容器背景，避免 xterm 首帧前后闪色。 */
export function terminalBackground(light: boolean): string {
  return (light ? LIGHT_THEME : DARK_THEME).background ?? (light ? '#ffffff' : '#1a1a1a')
}

/** 主题值比较：只在真的变了才写 options.theme，避免重建调色板。 */
export function sameTerminalTheme(a: ITheme | undefined, b: ITheme): boolean {
  if (!a) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ITheme>
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}
