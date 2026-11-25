import type { ITheme } from '@xterm/xterm'
import { contrastRatio, hexToRgb, over, rgbaString, type Rgba } from './color'

/**
 * 深色配色：底色与前景沿用 ssh-web 出版物黑，ANSI 调色板取自 orca 默认深色主题
 * （Ghostty Default Style Dark），在 #141414 上比原来的低饱和色更易读。
 */
const DARK_THEME: ITheme = {
  background: '#141414',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#141414',
  selectionBackground: '#5a7898',
  selectionForeground: '#ffffff',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
}

/**
 * 亮色配色：白底黑字保持出版物风格，ANSI 调色板取自 orca 的 Builtin Tango Light。
 * 白底下黄/青/绿若照搬 Tango 原值几乎看不清，orca 已把这几档压暗，这里直接沿用。
 */
const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#accef7',
  selectionForeground: '#1a1a1a',
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#8e7700',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#05727e',
  white: '#6a6a6a',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#1b7a1b',
  brightYellow: '#6d5a00',
  brightBlue: '#204a87',
  brightMagenta: '#ad7fa8',
  brightCyan: '#034b50',
  brightWhite: '#3d3d3d',
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
  return (light ? LIGHT_THEME : DARK_THEME).background ?? (light ? '#ffffff' : '#141414')
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
