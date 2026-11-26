import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = process.env.PI_SESSIONS_API ?? 'http://127.0.0.1:30200'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // 组件库是 file: 依赖，强制 React 单实例，避免两份运行时。
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 5186,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0',
    port: 4186,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: { outDir: 'dist' },
})
