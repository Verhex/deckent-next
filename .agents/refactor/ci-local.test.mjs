import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, runStep, stopGroup, cleanBaseEnv, classifyStep, assertSupportedPlatform } from '../../scripts/ci-local.mjs';
import { validateReceipt } from '../../scripts/land-check.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-local-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const alive = pgid => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
// POSIX process groups and bash hooks: other platforms get a typed not-run record (host tool, ubuntu workflow mirror).
function posixTest(name, fn) {
  const reason = process.platform === 'win32' && 'CI_LOCAL_UNSUPPORTED_PLATFORM: ci:local/land:check manage POSIX process groups and bash hooks; no Windows implementation';
  if (reason) console.log('verify-not-run: ' + JSON.stringify({ file: '.agents/refactor/ci-local.test.mjs', test: name, state: 'skipped', reason }));
  return test(name, { skip: reason }, fn);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

posixTest('cancelling a step empties its whole process group, descendants included', async t => {
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

posixTest('lock: second acquire refused; stays held while the step group lives although the run pid is dead; released after', async t => {
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

posixTest('lock: an unreadable or empty lock fails closed', t => {
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

posixTest('unmarked push never runs ci:local; marked push does; receipt is reused', t => {
  const r = landRepo(t);
  assert.equal(r.push().status, 0); assert.equal(r.runs(), 0);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0); assert.equal(r.runs(), 1);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0); assert.equal(r.runs(), 1, 'receipt reused');
});

posixTest('a failed --force removes the older PASS: the next marked push is rejected', t => {
  const r = landRepo(t);
  assert.equal(r.land().status, 0); assert.ok(fs.existsSync(r.receipt));
  const failed = r.land({ STUB_FAIL: '1' }, '--force');
  assert.equal(failed.status, 1); assert.equal(fs.existsSync(r.receipt), false, 'old receipt gone');
  assert.notEqual(r.push({ DECKENT_LANDING: '1', STUB_FAIL: '1' }).status, 0);
  assert.equal(r.push({ DECKENT_LANDING: '1' }).status, 0, 'passes only by really re-running');
});

posixTest('an invalid receipt is not trusted', t => {
  const r = landRepo(t);
  fs.mkdirSync(path.dirname(r.receipt), { recursive: true }); fs.writeFileSync(r.receipt, '');
  assert.equal(r.land().status, 0); assert.equal(r.runs(), 1, 're-ran instead of trusting an empty file');
});

posixTest('an interrupted run leaves no receipt (even over an older PASS) and stub receipts never land in passed/', async t => {
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

test('Windows gets a typed refusal (platform injected); POSIX is accepted', () => {
  assert.throws(() => assertSupportedPlatform('win32'), /CI_LOCAL_UNSUPPORTED_PLATFORM/u);
  assert.doesNotThrow(() => assertSupportedPlatform('linux'));
  assert.doesNotThrow(() => assertSupportedPlatform('darwin'));
});

test('a step that exits 0 but whose group is not proven gone is a failure that holds custody', () => {
  assert.deepEqual(classifyStep({ code: 0, reaped: { settled: true } }), { outcome: 'success', hold: false });
  assert.deepEqual(classifyStep({ code: 0, reaped: { settled: false } }), { outcome: 'failure', hold: true });
  assert.deepEqual(classifyStep({ code: 1, reaped: { settled: true } }), { outcome: 'failure', hold: false });
});

posixTest('normal exit + failed drain: run is FAILED, no further step, lock and worktree stay', async t => {
  const dir = tmp(t);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 'a');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts', 'ci-temporary-environment.mjs'), path.join(dir, 'scripts', 'ci-temporary-environment.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}'); git('add', '-A'); git('commit', '-qm', 'base');
  const driver = path.join(dir, 'driver.mjs');
  fs.writeFileSync(driver, `import { main } from ${JSON.stringify(path.join(root, 'scripts', 'ci-local.mjs'))};
process.exit(await main(['--ref', 'HEAD', '--node', ${JSON.stringify(process.versions.node.split('.')[0])}], { reap: async pgid => ({ pgid, sentTerm: true, sentKill: true, settled: false, waitedMs: 1 }) }));`);
  const run = spawnSync(process.execPath, [driver], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI_LOCAL_QUIET: '1' } });
  const scratch = /scratch=(\S+)/u.exec(run.stdout)?.[1];
  t.after(() => { spawnSync('git', ['worktree', 'remove', '--force', path.join(scratch, 'wt')], { cwd: dir }); fs.rmSync(scratch, { recursive: true, force: true }); });
  assert.equal(run.status, 1); assert.match(run.stdout, /FAILED/u);
  assert.match(run.stderr, /not proven gone/u);
  assert.ok(fs.existsSync(path.join(dir, '.git', 'ci-local.lock')), 'lock kept');
  assert.ok(fs.existsSync(path.join(scratch, 'wt')), 'worktree kept');
  const logs = fs.readdirSync(path.join(dir, '.pack', 'ci-local'));
  const result = JSON.parse(fs.readFileSync(path.join(dir, '.pack', 'ci-local', logs[0], 'result.json'), 'utf8'));
  assert.equal(result.exit, 1); assert.equal(result.unsettled.step, 'temporary-parent');
  assert.equal(result.outcomes.npmCi, 'skipped', 'no later step ran');
  assert.equal(fs.existsSync(path.join(dir, '.pack', 'ci-local', logs[0], 'npm-ci.log')), false);
});
