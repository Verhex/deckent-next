import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'apps'],
    pool: 'forks',
    maxWorkers: Number(process.env.VITEST_MAX_FORKS ?? 2),
    testTimeout: 30_000,
  },
});
