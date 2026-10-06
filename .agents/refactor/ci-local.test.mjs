import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, runStep, stopGroup, cleanBaseEnv } from '../../scripts/ci-local.mjs';
import { validateReceipt } from '../../scripts/land-check.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const alive = pgid => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('cancelling a step empties its whole process group, descendants included', async t => {
  const dir = tmp(t);
  let pgid = null;
  const step = runStep('t', 'bash', ['-c', 'sleep 300 & sleep 300 & wait'], { cwd: dir, env: process.env, logFile: path.join(dir, 'log'), onGroup: g => { pgid = g; } });
  await sleep(300);
  assert.ok(alive(pgid), 'group runs');
  const evidence = await stopGroup(pgid, { termMs: 3000, killMs: 2000 });
  assert.equal(evidence.settled, true); assert.equal(evidence.sentTerm, true);
  assert.equal(alive(pgid), false, 'no descendant survives');
  await step;
});

test('lock: second acquire refused; stays held while the step group lives although the run pid is dead; released after', async t => {
  const dir = tmp(t); const file = path.join(dir, 'lock');
  const first = acquireLock(file, { pid: process.pid, ref: 'a', startedAt: 'now' });
  assert.throws(() => acquireLock(file, { pid: process.pid, ref: 'b', startedAt: 'now' }), /CI_LOCAL_BUSY/u);
  const group = spawn('bash', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  first.setGroup(group.pid);
  const held = JSON.parse(fs.readFileSync(file, 'utf8')); held.pid = 2 ** 22 + 7; // run process gone, group alive
  fs.writeFileSync(file, JSON.stringify(held));
  assert.throws(() => acquireLock(file, { pid: process.pid, ref: 'c', startedAt: 'now' }), /process group/u);
  assert.equal((await stopGroup(group.pid, { termMs: 3000, killMs: 2000 })).settled, true);
  const second = acquireLock(file, { pid: process.pid, ref: 'd', startedAt: 'now' }); // stale now: accepted
  first.release(); assert.ok(fs.existsSync(file), 'a foreign token never releases');
  second.release(); assert.equal(fs.existsSync(file), false);
});

test('lock: an unreadable or empty lock fails closed', t => {
  const dir = tmp(t); const file = path.join(dir, 'lock');
  fs.writeFileSync(file, '');
  assert.throws(() => acquireLock(file, { pid: process.pid, ref: 'a', startedAt: 'now' }), /unreadable/u);
});

test('inherited lane/worker tuning does not reach the mirror', () => {
  const env = cleanBaseEnv({ VITEST_MAX_FORKS: '2', NODE_OPTIONS: '--x', GIT_DIR: '/x', npm_config_foo: '1', PATH: '/bin', DECKENT_X: '1' });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

test('receipt validation rejects empty, foreign, failed and stub-as-real receipts', () => {
  const good = { schema: 1, source: 'ci-local', sha: 'S', node: 'v24.21.0', exit: 0, outcomes: { a: 'success' }, counts: { passed: 5, failed: 0 }, logs: '/l', passedAt: 't' };
  assert.equal(validateReceipt(JSON.stringify(good), 'S', 'ci-local'), null);
  assert.equal(validateReceipt('', 'S', 'ci-local'), 'unparseable');
  assert.equal(validateReceipt(JSON.stringify(good), 'T', 'ci-local'), 'sha-mismatch');
  assert.equal(validateReceipt(JSON.stringify({ ...good, source: 'stub' }), 'S', 'ci-local'), 'source-mismatch');
  assert.equal(validateReceipt(JSON.stringify({ ...good, counts: { passed: 5, failed: 1 } }), 'S', 'ci-local'), 'counts-not-pass');
  assert.equal(validateReceipt(JSON.stringify({ ...good, outcomes: { a: 'failure' } }), 'S', 'ci-local'), 'outcomes-not-success');
});

function landRepo(t) {
  const dir = tmp(t);
  const run = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q'); run('config', 'user.email', 'a@b'); run('config', 'user.name', 'a');
  fs.mkdirSync(path.join(dir, 'scripts', 'git-hooks'), { recursive: true });
  for (const f of ['land-check.mjs']) fs.copyFileSync(path.join(root, 'scripts', f), path.join(dir, 'scripts', f));
  fs.copyFileSync(path.join(root, 'scripts', 'git-hooks', 'pre-push'), path.join(dir, 'scripts', 'git-hooks', 'pre-push'));
  fs.writeFileSync(path.join(dir, 'f'), 'x'); run('add', '-A'); run('commit', '-qm', 'base');
  const sha = run('rev-parse', 'HEAD').stdout.trim();
  const stub = path.join(dir, 'stub.mjs'); const counter = path.join(dir, 'count');
  fs.writeFileSync(stub, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(counter)}, 'x');
if (process.env.STUB_SLEEP) await new Promise(r => setTimeout(r, 60000));
process.exit(process.env.STUB_FAIL ? 1 : 0);`);
  const env = { ...process.env, DECKENT_CI_LOCAL_SCRIPT: stub };
  delete env.STUB_FAIL;
  const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);
  const land = (extra = {}, ...args) => spawnSync(process.execPath, ['scripts/land-check.mjs', ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const push = (extra = {}) => spawnSync('bash', ['scripts/git-hooks/pre-push'], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8',
    input: `refs/heads/x ${sha} refs/heads/main ${'0'.repeat(40)}\n` });
  return { dir, sha, runs, land, push, receipt: path.join(dir, '.pack', 'ci-local', 'passed-test', sha) };
}

test('unmarked push never runs ci:local; marked push does; receipt is reused', t => {
  const r = landRepo(t);
  assert.equal(r.push().status, 0); assert.equal(r.runs(), 0);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0); assert.equal(r.runs(), 1);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0); assert.equal(r.runs(), 1, 'receipt reused');
});

test('a failed --force removes the older PASS: the next marked push is rejected', t => {
  const r = landRepo(t);
  assert.equal(r.land().status, 0); assert.ok(fs.existsSync(r.receipt));
  const failed = r.land({ STUB_FAIL: '1' }, '--force');
  assert.equal(failed.status, 1); assert.equal(fs.existsSync(r.receipt), false, 'old receipt gone');
  assert.notEqual(r.push({ DECKENT_LANDING: '1', STUB_FAIL: '1' }).status, 0);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0, 'passes only by really re-running');
});

test('an invalid receipt is not trusted', t => {
  const r = landRepo(t);
  fs.mkdirSync(path.dirname(r.receipt), { recursive: true }); fs.writeFileSync(r.receipt, '');
  assert.equal(r.land().status, 0); assert.equal(r.runs(), 1, 're-ran instead of trusting an empty file');
});

test('an interrupted run leaves no receipt (even over an older PASS) and stub receipts never land in passed/', async t => {
  const r = landRepo(t);
  assert.equal(r.land().status, 0);
  assert.equal(fs.existsSync(path.join(r.dir, '.pack', 'ci-local', 'passed')), false, 'seam never writes the production directory');
  const child = spawn(process.execPath, ['scripts/land-check.mjs', '--force'], { cwd: r.dir, env: { ...process.env, DECKENT_CI_LOCAL_SCRIPT: path.join(r.dir, 'stub.mjs'), STUB_SLEEP: '1' }, stdio: 'ignore' });
  await sleep(1000);
  assert.equal(fs.existsSync(r.receipt), false, 'invalidated while the re-run is in progress');
  child.kill('SIGTERM');
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 130); assert.equal(fs.existsSync(r.receipt), false);
});
