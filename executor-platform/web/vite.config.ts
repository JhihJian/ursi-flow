import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const shared = fileURLToPath(new URL('../../workbench/web', import.meta.url))
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'URSI_')
  const proxy = { '/api/v2': { target: env.URSI_EXECUTOR_API_PROXY || 'http://127.0.0.1:8081' } }
  return {
    plugins: [react()],
    define: { 'import.meta.env.URSI_EXECUTOR_CONSOLE': 'true' },
    resolve: { alias: { '@': `${shared}/src` }, dedupe: ['react', 'react-dom', 'react-router'] },
    server: { host: '0.0.0.0', port: 5175, proxy, fs: { allow: ['.', shared] } },
    preview: { host: '0.0.0.0', port: 4175, proxy },
  }
})
