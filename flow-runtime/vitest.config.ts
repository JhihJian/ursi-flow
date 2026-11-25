import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/{variables,runtime,runtime-tool-contract,trajectory,runs,mcp-executor}.test.ts'] } });
