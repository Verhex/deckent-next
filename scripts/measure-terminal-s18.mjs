import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output || output.startsWith('-')) {
  console.error('usage: node scripts/measure-terminal-s18.mjs <latency.json>');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/contracts/surfaces/terminal-surface-push.test.ts'], {
  cwd: root,
  env: { ...process.env, S18_LATENCY_OUTPUT: resolve(output), VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? '2' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
