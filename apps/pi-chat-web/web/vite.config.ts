import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** 对话模块没有自己的服务端：接口一律走管理台，独立开发时把前缀代理到 8093。 */
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
    proxy: {
      '/api': 'http://127.0.0.1:8093',
    },
  },
})
