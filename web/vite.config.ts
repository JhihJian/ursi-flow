import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['URSI_', 'VITE_'])
  const apiMode = mode === 'live' ? 'live' : env.VITE_API_MODE || 'mock'
  if (!['mock', 'live'].includes(apiMode)) throw new Error('VITE_API_MODE 仅支持 mock 或 live')
  return {
    define: { 'import.meta.env.VITE_API_MODE': JSON.stringify(apiMode) },
    plugins: [react()],
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
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      unstubGlobals: true,
    },
  }
})
