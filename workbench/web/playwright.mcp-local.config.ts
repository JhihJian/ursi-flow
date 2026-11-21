import config from './playwright.config'
import { defineConfig } from '@playwright/test'
const url = 'http://127.0.0.1:4187'
export default defineConfig({ ...config, use: { ...config.use, baseURL: url }, webServer: { command: 'npm run preview -- --port 4187', url, reuseExistingServer: false } })
