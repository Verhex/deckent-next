#!/usr/bin/env node
// Landing gate (developer tooling): runs the local CI mirror for an exact SHA and, on PASS only, writes the receipt
// .pack/ci-local/passed/<sha>. A receipt for the same SHA returns PASS without re-running (--force re-runs).
// Usage: node scripts/land-check.mjs [--ref <git-ref|HEAD>] [--force]
// DECKENT_CI_LOCAL_SCRIPT overrides the mirror script (test seam; default scripts/ci-local.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const at = args.indexOf('--ref');
const ref = at >= 0 ? args[at + 1] : 'HEAD';
if (!ref || args.some(a => !['--force', '--ref', ref].includes(a))) { console.error('usage: land-check [--ref <git-ref|HEAD>] [--force]'); process.exit(2); }
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' });
const top = git('rev-parse', '--show-toplevel').stdout.trim();
const resolved = git('rev-parse', '--verify', `${ref}^{commit}`);
if (resolved.status !== 0) { console.error(`land:check: cannot resolve ${ref}`); process.exit(2); }
const sha = resolved.stdout.trim();
const receipt = join(top, '.pack', 'ci-local', 'passed', sha);
if (!force && existsSync(receipt)) { console.log(`land:check PASS (receipt reused, no re-run): ${sha}`); process.exit(0); }
const script = process.env.DECKENT_CI_LOCAL_SCRIPT || join(top, 'scripts', 'ci-local.mjs');
const run = spawnSync(process.execPath, [script, '--ref', sha, '--node', '24'], { stdio: 'inherit' });
if (run.status !== 0) { console.error(`land:check FAIL: ci:local exited ${run.status}; no receipt written`); process.exit(1); }
mkdirSync(join(top, '.pack', 'ci-local', 'passed'), { recursive: true });
writeFileSync(receipt, JSON.stringify({ sha, node: 24, passedAt: new Date().toISOString() }) + '\n');
console.log(`land:check PASS: receipt ${receipt}`);
