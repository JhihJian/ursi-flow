import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { apiProxy } from './src/app/dev-proxy'
import { lanPreviewProxy } from './src/app/lan-preview-proxy'
import { lanPreviewMode } from './src/shared/http/lan-preview'

export default defineConfig(({ mode, command, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), 'URSI_')
  const api = env.URSI_API_PROXY || 'http://127.0.0.1:8080'
  const lan = mode === lanPreviewMode
  if (lan && command === 'serve' && !isPreview) throw new Error('免登录模式仅支持 build 和 preview。')
  const gateway = lan && isPreview ? lanPreviewProxy(api, env) : undefined
  // Vite 只默认放行 IP 与 localhost。局域网里常用 mDNS 名或自建域名打开页面，
  // 额外允许的主机名由 URSI_ALLOWED_HOSTS 以逗号分隔给出，需写成 `.example.com` 或完整主机名。
  const allowedHosts = [
    '.local',
    ...(env.URSI_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  ]
  return {
    plugins: [react(), gateway?.plugin],
    build: { outDir: lan ? 'dist-lan' : 'dist' },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      conditions: ['ursi-source', ...defaultClientConditions],
      dedupe: ['react', 'react-dom', 'react-router'],
    },
    ssr: { resolve: { conditions: ['ursi-source', 'module', 'node', 'development|production'] }, noExternal: ['@ursi/mcp-web'] },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts,
      proxy: apiProxy(api),
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      strictPort: true,
      allowedHosts,
      cors: gateway ? false : undefined,
      proxy: gateway ? gateway.proxy : apiProxy(api),
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      restoreMocks: true,
      unstubGlobals: true,
    },
  }
})
