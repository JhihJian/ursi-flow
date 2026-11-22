import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  projects: [
    { name: 'desktop', use: devices['Desktop Chrome'] },
    { name: 'mobile', use: devices['Pixel 7'] },
  ],
  use: { baseURL: 'http://127.0.0.1:4185' },
  webServer: { command: 'npm run build && npm run preview -- --port 4185 --strictPort', url: 'http://127.0.0.1:4185' },
})
