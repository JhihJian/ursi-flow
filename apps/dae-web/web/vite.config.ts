import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * dae API 只接受不带外部 Origin 的请求，开发代理由服务端身份访问时去掉来源头，
 * 这样开发态与生产态（同源 Node 代理）行为一致。
 */
const apiTarget = process.env.DAE_WEB_API ?? 'http://127.0.0.1:9527'

export default defineConfig({
  // esbuild 在多浏览器目标下降级 ES2021 逻辑赋值时可能弄丢枚举 IIFE 的 let 声明
  // （曾致 xterm requestMode 崩溃），内网环境直接钉到 es2022 原生保留。
  build: { target: 'es2022' },
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5186,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4186,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
})
