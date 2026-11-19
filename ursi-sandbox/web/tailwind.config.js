const tokens = [
  'base',
  'surface',
  'elevated',
  'line',
  'line-strong',
  'txt',
  'txt2',
  'txt3',
  'accent',
  'accent-2',
  'accent-dim',
  'ok',
  'warn',
  'err',
]
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: Object.fromEntries(
        tokens.map((k) => [k, `rgb(var(--c-${k}) / <alpha-value>)`]),
      ),
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)' },
    },
  },
}
