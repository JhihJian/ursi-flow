import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  server: { host: '0.0.0.0', port: 4173, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../dist-preview', import.meta.url)), emptyOutDir: true },
})
