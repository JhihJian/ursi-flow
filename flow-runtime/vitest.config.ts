import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/{parser,variables,runtime,runtime-tool-contract,trajectory,runs}.test.ts'] } });
