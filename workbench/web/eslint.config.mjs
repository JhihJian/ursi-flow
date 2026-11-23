import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const domains = ['flows', 'runs', 'config', 'chat']
const restrict = (names) => ['error', {
  patterns: [{
    regex: `^@/(${names.join('|')})(/|$)`,
    message: '遵守模块依赖方向：app 组装业务模块，业务模块依赖 shared。',
  }],
}]

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'dist-lan/**', 'coverage/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(['app', 'modules', 'mocks']) },
  },

  ...domains.map((domain) => ({
    files: [`src/modules/${domain}/**/*.{ts,tsx}`],
    rules: { 'no-restricted-imports': restrict(['app', ...domains.filter((other) => other !== domain).map((name) => `modules/${name}`)]) },
  })),
)
