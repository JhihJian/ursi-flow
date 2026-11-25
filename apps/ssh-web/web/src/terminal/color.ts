/** sRGB 通道 0-255 与 alpha 0-1。主题染色与对比度门限共用。 */
export type Rgba = readonly [number, number, number, number]

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 对比度，入参须为不透明色。 */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** 把带 alpha 的前景色叠到不透明背景上。 */
export function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

export function hexToRgb(hex: string): Rgba | null {
  const clean = hex.trim().replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
    1,
  ]
}

export function rgbaString([r, g, b]: Rgba, alpha: number): string {
  const round = (value: number) => Math.round(value)
  return `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${alpha})`
}
