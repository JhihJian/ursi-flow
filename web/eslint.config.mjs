import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

const domains = ['workflows', 'roles', 'runs', 'artifacts', 'sandboxes', 'connections']
const restrict = (names) => ['error', {
  patterns: [{
    regex: `(^|/)(${names.join('|')})(/|$)`,
    message: '遵守模块依赖方向：app 组装业务模块，业务模块依赖 shared。',
  }],
}]

export default defineConfigWithVueTs(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  {
    files: ['src/shared/**/*.{ts,vue}'],
    rules: { 'no-restricted-imports': restrict(['app', 'modules', ...domains]) },
  },
  ...domains.map((domain) => ({
    files: [`src/modules/${domain}/**/*.{ts,vue}`],
    rules: { 'no-restricted-imports': restrict(['app', ...domains.filter((other) => other !== domain)]) },
  })),
)
