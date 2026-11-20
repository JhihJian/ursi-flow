import { defineConfig, devices } from '@playwright/test'
import { origin, ports } from './patches-acceptance/fixtures/ports'

export default defineConfig({
  testDir: './acceptance/tests',
  outputDir: './acceptance/.run/artifacts',
  workers: 1,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'acceptance/evidence/playwright-report.json' }]],
  globalSetup: './patches-acceptance/global-setup.ts',
  globalTeardown: './patches-acceptance/global-teardown.ts',
  use: { baseURL: origin(ports.web), trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: devices['Desktop Chrome'] },
    { name: 'mobile', use: devices['Pixel 7'] },
  ],
})
