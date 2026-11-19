import { defineConfig, devices } from '@playwright/test'
import { origin, ports } from './acceptance/fixtures/ports'

/**
 * 联合验收：真实 Web（构建产物 + 同源代理）、真实 ursi-server、真实 Pi CLI。
 * 只有模型是模拟的：本机固定回复端点，见 acceptance/fixtures/model-server.ts。
 *
 * web/ 下一行复跑：npm run test:acceptance
 */
export default defineConfig({
  testDir: './acceptance/tests',
  outputDir: './acceptance/.run/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalTimeout: 25 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'acceptance/evidence/playwright-report.json' }]],
  globalSetup: './acceptance/global-setup.ts',
  globalTeardown: './acceptance/global-teardown.ts',
  use: {
    baseURL: origin(ports.mainWeb),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: /main\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'sources',
      testMatch: /sources\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: origin(ports.sourcesWeb) },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
  ],
})
