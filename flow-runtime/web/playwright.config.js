import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.mjs',
  globalTeardown: './e2e/global-teardown.mjs',
  use: { baseURL: 'http://127.0.0.1:14483' },
  webServer: [
    {
      command:
        'mkdir -p .e2e-home .e2e-work && npm run build && python3 -m http.server 14484 --bind 127.0.0.1',
      url: 'http://127.0.0.1:14484/dist/',
      reuseExistingServer: false,
    },
    {
      command: 'mkdir -p .e2e-home .e2e-work && node server.mjs',
      env: {
        PORT: '14483',
        URSI_FLOW_HOME: new URL('./.e2e-home', import.meta.url).pathname,
        URSI_FLOW_WORKDIR: new URL('./.e2e-work', import.meta.url).pathname,
        URSI_FLOW_WEB_TLS_CERT: '',
      },
      url: 'http://127.0.0.1:14483/console-config.json',
      reuseExistingServer: false,
    },
  ],
})
