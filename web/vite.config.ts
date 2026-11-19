import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { apiProxy } from './src/app/dev-proxy'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'URSI_')
  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: apiProxy(env.URSI_API_PROXY || 'http://127.0.0.1:8080'),
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      // 生产构建预览与开发服务器使用同一套同源代理，目标由 URSI_API_PROXY 决定。
      proxy: apiProxy(env.URSI_API_PROXY || 'http://127.0.0.1:8080'),
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      unstubGlobals: true,
    },
  }
})
