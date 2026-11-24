export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: Object.fromEntries(
        [
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
          'info',
        ].map((k) => [k, `rgb(var(--c-${k}) / <alpha-value>)`]),
      ),
      fontFamily: {
        sans: [
          '"SF Mono"',
          'Menlo',
          'Monaco',
          '"Cascadia Mono"',
          '"Courier New"',
          'monospace',
        ],
        mono: [
          '"SF Mono"',
          'Menlo',
          'Monaco',
          '"Cascadia Mono"',
          '"Courier New"',
          'monospace',
        ],
        serif: ['Georgia', '"Times New Roman"', 'serif'],
      },
    },
  },
}
