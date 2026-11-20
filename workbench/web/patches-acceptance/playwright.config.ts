import { defineConfig, devices } from '@playwright/test'
import { origin, ports } from './fixtures/ports'

/**
 * 工作包与配置包联合验收：真实 Web 构建产物（Vite 预览 + 同源代理）与真实 Rust Server。
 * 不启动 Pi、模型或 Flow 守护进程。
 *
 * web/ 下复跑：npx playwright test --config patches-acceptance/playwright.config.ts
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
    { name: 'desktop', testMatch: /patches\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testMatch: /patches\.spec\.ts$/, use: { ...devices['Pixel 7'] } },
  ],
})
