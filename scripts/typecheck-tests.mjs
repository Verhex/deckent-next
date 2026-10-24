#!/usr/bin/env node
// Type-checks the test files a change touches (owner 2026-10-24): `npm run typecheck` covers src only (tsconfig excludes tests), so every
// touched test file must be error-free here. Untouched test files are not checked (their pre-existing errors shrink as files are touched).
// Files come from argv, or from the diff against `--base REF` (CI: the PR/merge-group base; empty or all-zero → merge-base with origin/main).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fail = message => { process.stderr.write(`typecheck-tests: ${message}\n`); process.exit(2); };
const git = (...args) => {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.status !== 0) fail(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout.split('\n').filter(Boolean);
};
const args = process.argv.slice(2), at = args.indexOf('--base');
let input = args;
if (at >= 0) {
  const ref = args[at + 1] ?? '';
  const base = ref && !/^0+$/u.test(ref) ? ref : git('merge-base', 'HEAD', 'origin/main')[0];
  input = git('diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD');
}
const files = [...new Set(input)].filter(file => /^tests\/.+\.m?ts$/u.test(file));
if (!files.length) { process.stdout.write('typecheck-tests: no changed test files\n'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'deckent-typecheck-tests-'));
try {
  const config = join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ extends: resolve('tsconfig.json'), compilerOptions: { rootDir: resolve('.'), typeRoots: [resolve('node_modules/@types')] },
    include: files.map(file => resolve(file)), exclude: [] }));
  const run = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '-p', config], { encoding: 'utf8' });
  const lines = run.stdout.split('\n');
  // A configuration error has no file; errors in imported, untouched files are not this check's subject.
  const errors = lines.filter(line => line.startsWith('error TS') || files.some(file => line.startsWith(`${file}(`)));
  // tsc: 0 clean, 1/2 diagnostics present; anything else (invalid project, crash) is not a result.
  if (![0, 1, 2].includes(run.status)) fail(`tsc exited ${run.status}\n${run.stderr}`);
  for (const line of errors) process.stdout.write(`${line}\n`);
  process.stdout.write(`typecheck-tests: ${files.length} changed test file(s), ${errors.length} error(s)\n`);
  process.exit(errors.length ? 1 : 0);
} finally { rmSync(dir, { recursive: true, force: true }); }
