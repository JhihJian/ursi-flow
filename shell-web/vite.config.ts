import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** 
 * 组合縫：todo-web 源码内部用 `@/` 引自身模块，宿主编译它时沿用同一别名。
 * 模块入口由 npm workspace 包 exports 解析（@ursi/todo-web、@ursi/fs-web），不再逐一设别名。
 */
const todoSrc = fileURLToPath(new URL('../todo-web/web/src', import.meta.url))
/** todo-web 的同源 API。 */
const todoApi = process.env.TODO_WEB_API ?? 'http://127.0.0.1:8090'
/** fs-web 的同源 API。 */
const fsApi = process.env.FS_WEB_API ?? 'http://127.0.0.1:8199'

const proxy = {
  // 顺序敏感：Vite 按插入顺序首个前缀命中生效，fs-web 必须排在通用 /api 之前。
  '/api/fs-web': { target: fsApi, changeOrigin: false },
  '/api': { target: todoApi, changeOrigin: false },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@/` 是 todo-web 源码内部的别名，宿主编译时保持一致解析。
    alias: [
      { find: /^@\//, replacement: `${todoSrc}/` },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '0.0.0.0', port: 5191, strictPort: true, proxy },
  preview: { host: '0.0.0.0', port: 4191, strictPort: true, proxy },
  build: { outDir: 'dist' },
})
