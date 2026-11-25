/**
 * 模块样式构建配置（npm run build:css）。
 * 与独立部署用的 tailwind.config.js 保持一致的类名映射与 important 前缀；
 * 关闭 preflight：宿主已有自己的元素重置，模块不得输出 html/body/:root 全局规则，
 * 模块内元素基线由 .sbx-app 作用域内的 tokens 与组件类承担。
 * 产物写入 dist/module.css，由宿主经 @ursi/sandbox-web/module.css 引入。
 */
import config from './tailwind.config.js'

export default {
  ...config,
  corePlugins: {
    ...config.corePlugins,
    preflight: false,
  },
  content: ['./src/**/*.{ts,tsx}', './index.html'],
}
