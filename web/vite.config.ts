import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['URSI_', 'VITE_'])
  const apiMode = mode === 'live' ? 'live' : env.VITE_API_MODE || 'mock'
  if (!['mock', 'live'].includes(apiMode)) throw new Error('VITE_API_MODE 仅支持 mock 或 live')
  return {
    define: { 'import.meta.env.VITE_API_MODE': JSON.stringify(apiMode) },
    plugins: [vue()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: env.URSI_API_PROXY || 'http://127.0.0.1:8080', ws: true },
      },
    },
    preview: { host: '0.0.0.0', port: 4173, strictPort: true, proxy: {} },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.ts'],
      restoreMocks: true,
      unstubGlobals: true,
    },
  }
})
