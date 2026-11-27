import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  // esbuild 多目标降级 ES2021 逻辑赋值时会弄丢声明（曾致 xterm 崩溃），钉到 es2022。
  build: { target: 'es2022' },
  plugins: [react()],
})
