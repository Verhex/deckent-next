import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

import { fileURLToPath } from 'node:url';

const pkgs = Object.keys(JSON.parse(readFileSync(new URL('./arch.json', import.meta.url), 'utf8')).packages);
const alias = Object.fromEntries(pkgs.map(p => [`#${p}`, fileURLToPath(new URL(`./src/${p}`, import.meta.url))]));

export default defineConfig({
  resolve: { alias },
  test: {
    reporters: ['default', './scripts/verification-reporter.mjs'],
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'apps'],
    pool: 'forks',
    maxWorkers: Number(process.env.VITEST_MAX_FORKS ?? 2),
    testTimeout: 30_000,
  },
});
