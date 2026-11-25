/**
 * Tailwind 配置：
 * - important: '.sbx-app' 让生成的每条规则都变成 `.sbx-app .bg-sbx-base` 这样的后代选择器，
 *   嵌入工作台外壳时不会污染宿主，也不与宿主的同名工具类相互覆盖。
 * - 调色板加 sbx- 前缀（bg-base → bg-sbx-base），避免与宿主工具类撞名。
 * - surface 保留原名：同时被 @apply 组件类与 packet-inspector.css 的变量消费。
 */
const palette = Object.fromEntries(
  [
    'base',
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
  ].map((k) => [`sbx-${k}`, `rgb(var(--c-${k}) / <alpha-value>)`]),
)

const monoStack = [
  '"SF Mono"',
  'Menlo',
  'Monaco',
  '"Cascadia Mono"',
  '"Courier New"',
  'monospace',
]

export default {
  important: '.sbx-app',
  corePlugins: {
    // 手写布局已覆盖容器查询用法，容器类不会生成（模块产物不允许未作用域规则）
    container: false,
  },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ...palette,
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
      },
      fontFamily: {
        sans: monoStack,
        mono: monoStack,
        serif: ['Georgia', '"Times New Roman"', 'serif'],
      },
    },
  },
}
