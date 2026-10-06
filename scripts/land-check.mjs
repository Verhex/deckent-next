#!/usr/bin/env node
// Landing gate (developer tooling): runs the local CI mirror for an exact SHA and, on a verified PASS only, publishes the
// receipt .pack/ci-local/passed/<sha>. A valid receipt for the same SHA returns PASS without re-running (--force re-runs).
// Usage: node scripts/land-check.mjs [--ref <git-ref|HEAD>] [--force]
// Fail closed: any existing receipt is removed BEFORE a re-run starts, so a failed, cancelled or still-running re-run can
// never leave an older PASS behind. The receipt is written atomically (temp + rename) from ci-local's own result.json
// and is validated on read (exact SHA, node 24, exit 0, all outcomes success, zero failed tests, source ci-local).
// DECKENT_CI_LOCAL_SCRIPT (stub seam for tests) uses a separate directory, passed-test/, which no production reader looks at.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReceipt(text, sha, source) {
  let receipt;
  try { receipt = JSON.parse(text); } catch { return 'unparseable'; }
  if (receipt?.schema !== 1 || receipt.sha !== sha) return 'sha-mismatch';
  if (receipt.source !== source) return 'source-mismatch';
  if (receipt.exit !== 0 || !/^v24\./u.test(receipt.node ?? '')) return 'result-not-pass';
  if (!receipt.outcomes || Object.values(receipt.outcomes).some(o => o !== 'success')) return 'outcomes-not-success';
  if (source === 'ci-local' && (receipt.counts?.failed !== 0 || !(receipt.counts?.passed > 0))) return 'counts-not-pass';
  if (!receipt.logs || !receipt.passedAt) return 'incomplete';
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const at = args.indexOf('--ref');
  const ref = at >= 0 ? args[at + 1] : 'HEAD';
  if (!ref || args.some(a => !['--force', '--ref', ref].includes(a))) { console.error('usage: land-check [--ref <git-ref|HEAD>] [--force]'); return 2; }
  const git = (...a) => spawnSync('git', a, { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) });
  const top = git('rev-parse', '--show-toplevel').stdout.trim();
  const resolved = git('rev-parse', '--verify', `${ref}^{commit}`);
  if (resolved.status !== 0) { console.error(`land:check: cannot resolve ${ref}`); return 2; }
  const sha = resolved.stdout.trim();
  const seam = process.env.DECKENT_CI_LOCAL_SCRIPT;
  const source = seam ? 'stub' : 'ci-local';
  const dir = join(top, '.pack', 'ci-local', seam ? 'passed-test' : 'passed');
  const receiptPath = join(dir, sha);
  if (!force && existsSync(receiptPath)) {
    const problem = validateReceipt(readFileSync(receiptPath, 'utf8'), sha, source);
    if (!problem) { console.log(`land:check PASS (valid receipt reused, no re-run): ${sha}`); return 0; }
    console.error(`land:check: existing receipt invalid (${problem}); removing and re-running`);
  }
  rmSync(receiptPath, { force: true }); // invalidate before anything can fail
  const logDir = join(top, '.pack', 'ci-local', `${sha.slice(0, 12)}-node24`);
  const resultPath = join(logDir, 'result.json');
  rmSync(resultPath, { force: true });
  const child = spawn(process.execPath, [seam || join(top, 'scripts', 'ci-local.mjs'), '--ref', sha, '--node', '24'], { stdio: 'inherit', cwd: top });
  let interrupted = null;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { interrupted = sig; child.kill(sig); });
  const status = await new Promise(done => { child.on('close', code => done(code ?? 1)); child.on('error', () => done(127)); });
  if (interrupted) { console.error(`land:check INTERRUPTED (${interrupted}); no receipt`); return 130; }
  if (status !== 0) { console.error(`land:check FAIL: ci:local exited ${status}; no receipt written`); return 1; }
  let result;
  if (source === 'ci-local') {
    try { result = JSON.parse(readFileSync(resultPath, 'utf8')); } catch { console.error('land:check FAIL: ci:local wrote no readable result.json; no receipt'); return 1; }
  } else result = { node: 'v24.0.0-stub', exit: 0, outcomes: { stub: 'success' }, counts: null };
  const receipt = { schema: 1, source, sha, node: result.node, exit: result.exit, outcomes: result.outcomes, counts: result.counts,
    totalSeconds: result.totalSeconds ?? null, logs: logDir, passedAt: new Date().toISOString() };
  if (source === 'ci-local' && result.sha !== sha) { console.error('land:check FAIL: result.json is for a different SHA; no receipt'); return 1; }
  const problem = validateReceipt(JSON.stringify(receipt), sha, source);
  if (problem) { console.error(`land:check FAIL: result not a verified pass (${problem}); no receipt`); return 1; }
  mkdirSync(dir, { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(temporary, receiptPath);
  console.log(`land:check PASS: receipt ${receiptPath}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => { console.error(error.message); process.exit(2); });
}
