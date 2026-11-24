import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** 暂时直接引用 todo-web 的源码，等模块协议稳定后再拆成独立包。 */
const todoSrc = fileURLToPath(new URL('../todo-web/web/src', import.meta.url))
const todoApi = process.env.TODO_WEB_API ?? 'http://127.0.0.1:8090'
/** fs-web 模块源码与服务。 */
const fsWebSrc = fileURLToPath(new URL('../fs-web/web/src', import.meta.url))
const fsApi = process.env.FS_WEB_API ?? 'http://127.0.0.1:8199'

const proxy = {
  // 顺序敏感：Vite 按插入顺序首个前缀命中生效，fs-web 必须排在通用 /api 之前。
  '/api/fs-web': { target: fsApi, changeOrigin: false },
  '/api': { target: todoApi, changeOrigin: false },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // '@/' 是 todo-web 源码内部的别名；'@todo' 供工作区入口引用。
    alias: [
      { find: /^@\//, replacement: `${todoSrc}/` },
      { find: '@todo', replacement: todoSrc },
      { find: '@fs-web', replacement: fsWebSrc },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '0.0.0.0', port: 5191, strictPort: true, proxy },
  preview: { host: '0.0.0.0', port: 4191, strictPort: true, proxy },
  build: { outDir: 'dist' },
})
