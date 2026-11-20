import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { apiProxy } from './src/app/dev-proxy'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'URSI_')
  const api = env.URSI_API_PROXY || 'http://127.0.0.1:8080'
  // Vite 只默认放行 IP 与 localhost。局域网里常用 mDNS 名或自建域名打开页面，
  // 额外允许的主机名由 URSI_ALLOWED_HOSTS 以逗号分隔给出，需写成 `.example.com` 或完整主机名。
  const allowedHosts = [
    '.local',
    ...(env.URSI_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  ]
  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts,
      proxy: apiProxy(api),
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      allowedHosts,
      // 生产构建预览与开发服务器使用同一套同源代理，目标由 URSI_API_PROXY 决定。
      proxy: apiProxy(api),
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
