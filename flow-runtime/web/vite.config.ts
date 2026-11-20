import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      '/api/v1': 'http://127.0.0.1:4181',
      '/console-config.json': 'http://127.0.0.1:4181',
    },
  },
})
