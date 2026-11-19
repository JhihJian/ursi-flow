import animate from 'tailwindcss-animate'

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
  'accent-hover',
  'accent-dim',
  'ok',
  'warn',
  'err',
  'info',
]
// shadcn 语义色，全部指向 tokens.css 里的调色板。
const semantic = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
]

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries(tokens.map((k) => [k, `rgb(var(--c-${k}) / <alpha-value>)`])),
        ...Object.fromEntries(semantic.map((k) => [k, `rgb(var(--${k}) / <alpha-value>)`])),
      },
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
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in var(--dur-ui) var(--ease-out-expo)',
        'slide-up': 'slide-up var(--dur-ui) var(--ease-out-expo)',
      },
    },
  },
  plugins: [animate],
}
