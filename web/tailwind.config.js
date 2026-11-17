/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: token('base'), surface: token('surface'), elevated: token('elevated'), overlay: token('overlay'),
        line: token('line'), 'line-strong': token('line-strong'),
        txt: token('txt'), txt2: token('txt2'), txt3: token('txt3'),
        accent: token('accent'), 'accent-2': token('accent-2'), 'accent-hover': token('accent-hover'), 'accent-dim': token('accent-dim'),
        ok: token('ok'), warn: token('warn'), err: token('err'), info: token('info'),
        canvas: token('base'), ink: token('txt'), muted: token('txt3'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        glow: '0 1px 3px rgb(var(--c-accent) / 0.18)',
      },
    },
  },
  plugins: [],
}
