import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:14482/dist/' },
  webServer: {
    command: 'npm run build && python3 -m http.server 14482 --bind 127.0.0.1',
    url: 'http://127.0.0.1:14482/dist/',
  },
})
