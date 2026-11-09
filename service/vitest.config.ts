import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres, so test files run one after another.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], fileParallelism: false, testTimeout: 20000 } });
