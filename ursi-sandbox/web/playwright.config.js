import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:14481' },
  webServer: {
    command: 'npm run build && node server.mjs',
    env: {
      PORT: '14481',
      URSI_WEB_PASSWORD: '',
      URSI_GATEWAY_URL: '',
      URSI_GATEWAY_KEY: '',
    },
    url: 'http://127.0.0.1:14481/sandboxes',
  },
})
