import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
    rollupOptions: {
      external: /^(react|react-dom|react-router)(\/|$)/,
      output: { banner: chunk => chunk.isEntry ? "import './style.css';" : '' },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
})
