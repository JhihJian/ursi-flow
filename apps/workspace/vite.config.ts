import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** monaco-editor 0.58 exports map 对深路径解析错误（esm/vs/esm/vs/...），用真实文件路径绕过。 */
const monacoEsm = fileURLToPath(new URL('../../node_modules/monaco-editor/esm/', import.meta.url))

/** 暂时直接引用 todo-web 的源码，等模块协议稳定后再拆成独立包。 */
const todoSrc = fileURLToPath(new URL('../../todo-web/web/src', import.meta.url))
const todoApi = process.env.TODO_WEB_API ?? 'http://127.0.0.1:8090'
/** workspace-web 模块源码与服务。 */
const workspaceWebSrc = fileURLToPath(new URL('../../workspace-web/web/src', import.meta.url))
const workspaceApi = process.env.WORKSPACE_WEB_API ?? 'http://127.0.0.1:8199'

const proxy = {
  '/api/todo': { target: todoApi, changeOrigin: false },
  '/api/workspace-web': { target: workspaceApi, changeOrigin: false },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // '@/' 是 todo-web 源码内部的别名；'@todo' 供工作区入口引用。
    alias: [
      { find: /^@\//, replacement: `${todoSrc}/` },
      { find: '@todo', replacement: todoSrc },
      { find: '@workspace-web', replacement: workspaceWebSrc },
      { find: /^monaco-editor\/esm\//, replacement: monacoEsm },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '0.0.0.0', port: 5191, strictPort: true, proxy },
  preview: { host: '0.0.0.0', port: 4191, strictPort: true, proxy },
  build: { outDir: 'dist' },
})
