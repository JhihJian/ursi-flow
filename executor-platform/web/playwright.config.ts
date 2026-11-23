import { defineConfig, devices } from '@playwright/test'

const lan = process.env.URSI_EXECUTOR_TEST_LAN === '1'
const mode = lan ? ' -- --mode lan-preview' : ''

export default defineConfig({
  testDir: './e2e',
  testMatch: lan ? '**/lan.spec.ts' : ['**/agent.spec.ts', '**/management.spec.ts'],
  projects: [
    { name: 'desktop', use: devices['Desktop Chrome'] },
    { name: 'mobile', use: devices['Pixel 7'] },
  ],
  use: { baseURL: 'http://127.0.0.1:4185' },
  webServer: { command: `npm run build${mode} && npm run preview -- --port 4185 --strictPort`, url: 'http://127.0.0.1:4185' },
})
