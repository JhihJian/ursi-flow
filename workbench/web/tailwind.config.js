import animate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`
const alias = (name) => `rgb(var(--${name}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
        background: alias('background'), foreground: alias('foreground'),
        card: { DEFAULT: alias('card'), foreground: alias('card-foreground') },
        popover: { DEFAULT: alias('popover'), foreground: alias('popover-foreground') },
        primary: { DEFAULT: alias('primary'), foreground: alias('primary-foreground') },
        secondary: { DEFAULT: alias('secondary'), foreground: alias('secondary-foreground') },
        destructive: { DEFAULT: alias('destructive'), foreground: alias('destructive-foreground') },
        border: alias('border'), input: alias('input'), ring: alias('ring'),
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        glow: '0 1px 3px rgb(var(--c-accent) / 0.18)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
}
