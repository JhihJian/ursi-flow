import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.SSH_WEB_API ?? 'http://127.0.0.1:8091'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5193,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0',
    port: 4193,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: false } },
  },
})
