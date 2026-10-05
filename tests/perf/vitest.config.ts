import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.js';

/** Separate latency lane: `VITEST_MAX_FORKS=1 npx vitest run --config tests/perf/vitest.config.ts`. The default suite never includes `*.perf.ts`.
 * Not mergeConfig: it concatenates arrays, which would add the whole default suite to `include`. */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/perf/**/*.perf.ts'], testTimeout: 180_000, maxWorkers: 1, fileParallelism: false },
});
