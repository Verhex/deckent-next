import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output || output.startsWith('-')) {
  console.error('usage: node scripts/measure-terminal-s18b.mjs <latency.json>');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/contracts/composition/terminal-surface-follow.test.ts', '-t', 'measures event production'], {
  cwd: root,
  env: { ...process.env, S18B_LATENCY_OUTPUT: target, VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? '2' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
