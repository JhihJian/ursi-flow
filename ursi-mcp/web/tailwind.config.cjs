const palette = {
  base: '250 250 251', surface: '255 255 255', elevated: '244 244 245', line: '226 226 232', 'line-strong': '208 208 216',
  txt: '24 24 27', txt2: '52 52 60', txt3: '82 82 91', accent: '123 97 255', 'accent-2': '79 70 229',
  'accent-hover': '84 36 216', 'accent-dim': '240 237 255', err: '220 38 38',
}
module.exports = {
  content: { relative: true, files: ['./src/**/*.{ts,tsx}'] },
  important: '.ursi-mcp',
  corePlugins: { preflight: false },
  theme: { extend: {
    colors: {
      ...Object.fromEntries(Object.entries(palette).map(([key, fallback]) => [key, `rgb(var(--c-${key}, ${fallback}) / <alpha-value>)`])),
      'primary-foreground': 'rgb(var(--primary-foreground, 255 255 255) / <alpha-value>)',
    },
    boxShadow: { card: 'var(--shadow-card, 0 1px 3px rgb(16 24 40 / .08))', glow: '0 1px 3px rgb(123 97 255 / .18)' },
  } },
}
