// 组件预览页。只用于开发时看效果，不进 build，不进 typecheck（tsconfig 只 include src/）。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'preview',
  plugins: [react()],
  // 包里没有 @vitejs/plugin-react，从 workspace 根解析。
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    fs: { allow: ['..'] },
  },
})
