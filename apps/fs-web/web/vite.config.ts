import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** fs-web 独立预览：以 web/ 为 vite root，API 代理到本机 fs-web 服务。 */
const fsApi = process.env.FS_WEB_API ?? 'http://127.0.0.1:8199'

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '0.0.0.0', port: 5192, strictPort: true, proxy: { '/api/fs-web': { target: fsApi, changeOrigin: false } } },
  preview: { host: '0.0.0.0', port: 4192, strictPort: true, proxy: { '/api/fs-web': { target: fsApi, changeOrigin: false } } },
  build: { outDir: 'dist' },
})
