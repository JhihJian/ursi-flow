// 出版物式设计令牌：纯灰度，无彩色强调（危险红除外）。
// 与 /data/web-style/ursi-style/ 保持一致：accent 一律映射为黑/深灰，
// err 为唯一的危险红 #b43c3c，其余语义色退化为灰度。
const palette = {
  base: '255 255 255', surface: '255 255 255', elevated: '229 229 229', line: '229 229 229', 'line-strong': '153 153 153',
  txt: '26 26 26', txt2: '102 102 102', txt3: '153 153 153',
  accent: '26 26 26', 'accent-2': '26 26 26', 'accent-hover': '0 0 0', 'accent-dim': '219 219 219',
  err: '180 60 60', ok: '102 102 102',
}
module.exports = {
  content: { relative: true, files: ['./src/**/*.{ts,tsx}'] },
  important: '.mcp-web',
  corePlugins: { preflight: false },
  theme: { extend: {
    colors: {
      ...Object.fromEntries(Object.entries(palette).map(([key, fallback]) => [key, `rgb(var(--c-${key}, ${fallback}) / <alpha-value>)`])),
      'primary-foreground': 'rgb(var(--primary-foreground, 255 255 255) / <alpha-value>)',
    },
    fontFamily: {
      mono: ['SF Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      serif: ['Georgia', '"Times New Roman"', 'serif'],
    },
    boxShadow: { card: 'none', glow: 'none' },
  } },
}
