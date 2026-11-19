import { defineConfig, devices } from '@playwright/test'
import { origin, ports } from './fixtures/ports'

/**
 * 回执工作区联合验收：真实 Web 构建产物（Vite 预览 + 同源代理）与真实 Rust Server。
 * 执行器只有内置 echo，不启动 Pi、模型或守护进程。
 *
 * web/ 下复跑：npx playwright test --config echo-acceptance/playwright.config.ts
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './.run/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'evidence/playwright-report.json' }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: origin(ports.web),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', testMatch: /(?:workspace|patches)\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testMatch: /(?:workspace|patches)\.spec\.ts$/, use: { ...devices['Pixel 7'] } },
  ],
})
