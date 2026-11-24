import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** 暂时直接引用 todo-web 的源码，等模块协议稳定后再拆成独立包。 */
const todoSrc = fileURLToPath(new URL('../../todo-web/web/src', import.meta.url))
const todoApi = process.env.TODO_WEB_API ?? 'http://127.0.0.1:8090'

const proxy = {
  '/api': { target: todoApi, changeOrigin: false },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // '@/' 是 todo-web 源码内部的别名；'@todo' 供工作区入口引用。
    alias: [
      { find: /^@\//, replacement: `${todoSrc}/` },
      { find: '@todo', replacement: todoSrc },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '0.0.0.0', port: 5191, strictPort: true, proxy },
  preview: { host: '0.0.0.0', port: 4191, strictPort: true, proxy },
  build: { outDir: 'dist' },
})
