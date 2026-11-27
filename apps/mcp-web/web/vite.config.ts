import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    // esbuild 多目标降级 ES2021 逻辑赋值时会弄丢声明（曾致 xterm 崩溃），钉到 es2022。
    target: 'es2022',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
    rollupOptions: {
      external: /^(react|react-dom|react-router)(\/|$)/,
      output: { banner: chunk => chunk.isEntry ? "import './style.css';" : '' },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
})
