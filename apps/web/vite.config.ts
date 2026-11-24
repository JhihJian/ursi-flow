import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: {
    portal: fileURLToPath(new URL('./index.html', import.meta.url)),
    manage: fileURLToPath(new URL('./manage/index.html', import.meta.url)),
  } } },
  resolve: { dedupe: ['react', 'react-dom'] },
})
