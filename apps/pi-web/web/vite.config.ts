import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** 合并后的 pi-web：页面与接口同源，独立开发时把 /api 代理到 8093。 */
const api = process.env.PI_WEB_API ?? 'http://127.0.0.1:8093'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 轨迹组件库把 react 写在 dependencies 里，不去重会出现两份运行时。
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 5193,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  preview: {
    host: '0.0.0.0',
    port: 4183,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  // esbuild 多目标降级 ES2021 逻辑赋值时会弄丢声明（曾致 xterm 崩溃），钉到 es2022。
  build: { target: 'es2022', outDir: 'dist' },
})
