import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.CHAT_WEB_API ?? 'http://127.0.0.1:8198'

export default defineConfig({
  // esbuild 多目标降级 ES2021 逻辑赋值时会弄丢声明（曾致 xterm 崩溃），钉到 es2022。
  build: { target: 'es2022' },
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5183,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0',
    port: 4184,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
})
