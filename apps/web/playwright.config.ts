import { defineConfig } from '@playwright/test'

const port = 54682
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL },
  webServer: {
    command: `vite --host 0.0.0.0 --port ${port} --strictPort`,
    url: baseURL,
    env: { VITE_WORKBENCH_URL: 'http://127.0.0.1:5173/work-items' },
  },
})
