#!/usr/bin/env node
// Fast pre-commit gate (developer tooling): typecheck + eslint on changed .ts/.mjs + lint-arch + lint-docs, in parallel.
// Not a substitute for `npm run ci:local`; it never runs tests.
import { spawnSync } from 'node:child_process';

const lines = args => spawnSync('git', args, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const changed = [...new Set([...lines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
  ...lines(['diff', '--name-only', '--diff-filter=ACMR'])])]
  .filter(file => /\.(ts|tsx|mts|mjs)$/u.test(file) && !/^(\.deckent|dist|\.pack|node_modules)\//u.test(file));
const quote = file => `'${file.replaceAll("'", `'\\''`)}'`;
const commands = ['npm run --silent typecheck', 'node scripts/lint-arch.mjs', 'node scripts/lint-docs.mjs'];
if (changed.length) commands.push(`npx --no-install eslint --no-warn-ignored ${changed.map(quote).join(' ')}`);
const started = Date.now();
const run = spawnSync(process.execPath, ['scripts/run-parallel.mjs', ...commands], { stdio: 'inherit' });
process.stdout.write(`\nprecommit:fast ${run.status === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s (${changed.length} changed file(s) linted)\n`);
process.exit(run.status ?? 1);
