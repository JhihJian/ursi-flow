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
/** ssh-web 的同源 API；前缀在代理层重写，服务端路由保持 /api 不动。 */
const sshApi = process.env.SSH_WEB_API ?? 'http://127.0.0.1:8091'
/** 沙箱 Gateway 控制台（server.mjs，含 HTTP Basic 认证代理）。 */
const sbxApi = process.env.SBX_WEB_API ?? 'http://127.0.0.1:4180'

const proxy = {
  // 顺序敏感：Vite 按插入顺序首个前缀命中生效，各模块前缀必须排在通用 /api 之前。
  '/api/fs-web': { target: fsApi, changeOrigin: false },
  '/api/ssh-web': {
    target: sshApi,
    changeOrigin: false,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/api\/ssh-web/, '/api'),
  },
  '/sbx': {
    target: sbxApi,
    changeOrigin: false,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/sbx/, ''),
  },
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
  build: {
    outDir: 'dist',
    // 两个页面入口：真实工作台与不依赖后端的骨架预览。
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        skeleton: fileURLToPath(new URL('./skeleton.html', import.meta.url)),
      },
    },
  },
})
