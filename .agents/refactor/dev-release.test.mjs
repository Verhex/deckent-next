import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRepository } from './dev-release-fake.mjs';
import { EventEmitter } from 'node:events';
import { layout, ledgerLock, rollback, start, switchTo } from './dev-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const sleep = ms => new Promise(done => setTimeout(done, ms));

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-release-')));
  const repo = join(base, 'checkout'), home = join(base, 'home'), data = join(base, 'data'), bwrap = join(base, 'bwrap');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(join(bwrap, 'out'), { recursive: true });
  const fake = fakeRepository(repo, join(base, 'origin.git'));
  mkdirSync(join(repo, '.agents/refactor'), { recursive: true });
  for (const name of ['dev-release.mjs', 'next-entry.mjs']) copyFileSync(join(here, name), join(repo, '.agents/refactor', name));
  mkdirSync(join(repo, '.deckent'), { mode: 0o700 });
  writeFileSync(join(repo, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }), { mode: 0o600 });
  const env = { ...process.env, HOME: home }; delete env.DECKENT_NEXT_INSTALL_ROOT; delete env.DECKENT_HOME;
  const installRoot = join(home, '.local/share/deckent-next-dev');
  const tool = (...args) => {
    const result = spawnSync(process.execPath, [join(repo, '.agents/refactor/dev-release.mjs'), ...args, '--bwrap', bwrap, '--start-timeout-ms', '20000', '--stop-timeout-ms', '20000'],
      { cwd: base, env, encoding: 'utf8', timeout: 180_000 });
    let json = null; try { json = JSON.parse(result.stdout); } catch { /* asserted by callers */ }
    return { status: result.status, json, stderr: result.stderr, stdout: result.stdout };
  };
  const cli = (...args) => spawnSync(process.execPath, [join(repo, '.agents/refactor/next-entry.mjs'), 'cli', ...args], { cwd: base, env, encoding: 'utf8', timeout: 30_000 });
  const describe = () => { const r = cli('runtime', 'describe', '--json'); return r.status === 0 ? JSON.parse(r.stdout) : null; };
  const ledger = join(data, 'state/ledger.db');
  const cleanup = () => {
    // Every process started from this fixture (fake services, launchers, clients) runs with the fixture path in its command line.
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(base) && Number(pid) !== process.pid) process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(base, { recursive: true, force: true });
  };
  return { base, repo, home, data, env, installRoot, fake, tool, cli, describe, ledger, cleanup, current: () => { try { return readlinkSync(join(installRoot, 'current')); } catch { return null; } } };
}
const refsHash = repo => execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' }) + readdirSync(join(repo, '.git')).sort().join(',');
async function startFromLauncher(f) {
  const child = spawn(process.execPath, [join(f.repo, '.agents/refactor/next-entry.mjs'), 'cli', 'runtime', 'serve', '--json'], { cwd: f.base, env: f.env, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 100; i++) { const d = f.describe(); if (d) return d; await sleep(100); }
  throw new Error('fake service did not start');
}

test('stage builds the exact pushed commit outside the source repository and refuses unknown, dirty, unpushed, unsmoked and sandbox-less input', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const good = f.fake.commit('good');
  const refsBefore = refsHash(f.repo);
  const staged = f.tool('stage', good);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const id = staged.json.id, dir = join(f.installRoot, 'versions', id);
  assert.match(id, new RegExp(`^${good.slice(0, 12)}-[0-9a-f]{12}$`));
  const release = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  assert.equal(release.sourceCommit, good); assert.equal(release.pushed, true); assert.equal(release.local, false); assert.equal(release.ledgerVersion, 43);
  assert.equal(release.protocolVersion, 18); assert.deepEqual(release.smoke, { tarball: { version: true, runtime: true }, unpacked: { version: true, runtime: true }, waived: [] });
  assert.ok(existsSync(join(dir, 'dist/composition/core/cli/internal/entry.js')));
  // Nothing written into the source repository's .git (clone --local --no-hardlinks, Jev 2b6f9f73), no build tree or partial left.
  assert.equal(refsHash(f.repo), refsBefore);
  assert.deepEqual(readdirSync(join(f.installRoot, 'build')), []);
  assert.deepEqual(readdirSync(join(f.installRoot, 'versions')), [id]);
  assert.equal(f.tool('stage', good).json.alreadyStaged, true);

  assert.equal(f.tool('stage', 'feedface').json.code, 'DEV_RELEASE_UNKNOWN_COMMIT');
  const local = f.fake.commit('local', { push: false });
  assert.equal(f.tool('stage', local).json.code, 'DEV_RELEASE_UNPUSHED');
  writeFileSync(join(f.repo, 'src/lazy.js'), 'export const where = "dirty";\n');
  assert.equal(f.tool('stage', 'HEAD').json.code, 'DEV_RELEASE_SOURCE_DIRTY');
  f.fake.git('checkout', '--quiet', '--', 'src/lazy.js');
  const allowed = f.tool('stage', local, '--allow-local');
  assert.equal(allowed.status, 0, allowed.stdout); assert.equal(allowed.json.release.local, true);
  const smokeFails = f.fake.commit('smoke-fails', { behavior: { smokeFail: true } });
  const smoke = f.tool('stage', smokeFails);
  assert.equal(smoke.json.code, 'DEV_RELEASE_SMOKE_FAILED'); assert.deepEqual(smoke.json.failed, ['runtime']);
  assert.equal(f.tool('stage', smokeFails, '--waive-smoke', 'terminal').json.code, 'DEV_RELEASE_SMOKE_FAILED', 'a waiver covers only the named check');
  const waived = f.tool('stage', smokeFails, '--waive-smoke', 'runtime');
  assert.equal(waived.status, 0, waived.stdout); assert.deepEqual(waived.json.release.smoke.waived, ['runtime']);
  const dirty = f.fake.commit('dirty-build', { behavior: { dirtyOnBuild: true } });
  assert.equal(f.tool('stage', dirty).json.code, 'DEV_RELEASE_BUILD_DIRTY');
  const noSandbox = f.fake.commit('no-bwrap', { behavior: { bwrapMissing: true } });
  assert.equal(f.tool('stage', noSandbox).json.code, 'DEV_RELEASE_UNPUBLISHABLE');
  // Publication-only blockers (licence texts, declaration leaks) are recorded, not refused: the dev installation is not a publication.
  const blocked = f.fake.commit('unpublishable', { behavior: { unpublishable: true } });
  const recorded = f.tool('stage', blocked);
  assert.equal(recorded.status, 0, recorded.stdout); assert.deepEqual(recorded.json.release.publishable, { ok: false, blockers: ['fake blocker'] });
  // A failed stage installs nothing: only the two staged versions exist, no partial directories, no build trees, pointer untouched.
  assert.deepEqual(readdirSync(join(f.installRoot, 'versions')).sort(), [id, allowed.json.id, recorded.json.id, waived.json.id].sort());
  assert.deepEqual(readdirSync(join(f.installRoot, 'build')), []);
  assert.equal(f.current(), null);
  const noBwrap = spawnSync(process.execPath, [join(f.repo, '.agents/refactor/dev-release.mjs'), 'stage', good], { env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(noBwrap.stdout).code, 'DEV_RELEASE_BWRAP_MISSING');
  const preview = f.fake.commit('preview', { push: false });
  const previewed = f.tool('stage', preview, '--preview');
  assert.equal(previewed.json.release.preview, true);
  assert.equal(f.tool('switch', previewed.json.id).json.code, 'DEV_RELEASE_PREVIEW_NOT_SWITCHABLE');
  assert.equal(f.tool('switch', allowed.json.id).json.code, 'DEV_RELEASE_UNREVIEWED');
});

test('switch stops the running service through its own CLI, moves the pointer atomically and starts the new version; a failed start rolls the pointer back', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const a = f.fake.commit('a'); execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: f.repo }); // today's layout: the service runs from the checkout dist
  const b = f.fake.commit('b'), broken = f.fake.commit('broken', { behavior: { serveExit: true } }), liar = f.fake.commit('liar', { behavior: { wrongBuild: true } });
  const ids = Object.fromEntries(Object.entries({ b, broken, liar }).map(([name, sha]) => [name, f.tool('stage', sha).json.id]));
  const before = await startFromLauncher(f);
  assert.equal(before.build.sourceCommit, a);
  assert.match(readFileSync(`/proc/${before.processId}/cmdline`, 'utf8'), new RegExp(`${f.repo}/dist/`));
  // A long-lived client started before the switch (MCP server kept open by its host) from version b… is created after the first switch below.
  const first = f.tool('switch', ids.b);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(f.current(), `versions/${ids.b}`);
  assert.equal(first.json.stoppedVia, join(f.repo, 'dist/composition/core/cli/internal/entry.js'));
  assert.equal(first.json.from, 'checkout'); assert.equal(first.json.service.build.sourceCommit, b);
  const shutdowns = readFileSync(join(f.data, 'state/shutdowns.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(shutdowns[0].instanceId, before.instanceId); assert.match(shutdowns[0].commandId, /^dev-release-switch-/);
  assert.equal(shutdowns[0].via, join(f.repo, 'dist/composition/core/cli/internal/entry.js'), 'the old service was stopped by its own CLI');
  assert.match(readFileSync(`/proc/${first.json.service.processId}/cmdline`, 'utf8'), new RegExp(`versions/${ids.b}/dist/`));
  assert.equal(readFileSync(join(f.installRoot, 'previous'), 'utf8').trim(), 'checkout');
  // The first live rollback: back to the checkout dist (pointer removed, next-entry falls back to the checkout).
  const home = f.tool('rollback');
  assert.equal(home.status, 0, home.stdout);
  assert.equal(f.current(), null); assert.equal(home.json.to, 'checkout');
  const again = f.describe(); assert.equal(again.build.sourceCommit, a);
  assert.match(readFileSync(`/proc/${again.processId}/cmdline`, 'utf8'), new RegExp(`${f.repo}/dist/`));
  assert.equal(readFileSync(join(f.installRoot, 'previous'), 'utf8').trim(), ids.b);
  // A failed switch away from the checkout puts the checkout back (no pointer) and restarts its service.
  const fromCheckout = f.tool('switch', ids.broken);
  assert.equal(fromCheckout.json.code, 'DEV_RELEASE_SWITCH_FAILED', fromCheckout.stdout); assert.equal(fromCheckout.json.pointer, 'checkout');
  assert.equal(f.current(), null); assert.equal(f.describe().build.sourceCommit, a);
  assert.equal(f.tool('switch', ids.b).status, 0);

  for (const bad of ['broken', 'liar']) {
    const failed = f.tool('switch', ids[bad]);
    assert.equal(failed.json.code, 'DEV_RELEASE_SWITCH_FAILED', failed.stdout);
    assert.equal(failed.json.pointer, ids.b);
    assert.equal(f.current(), `versions/${ids.b}`, 'pointer rolled back');
    assert.equal(f.describe().build.sourceCommit, b, 'previous version serves again');
    assert.deepEqual(readdirSync(f.installRoot).filter(name => name.startsWith('current.tmp')), []);
  }
  const log = readFileSync(join(f.installRoot, 'switches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.to, entry.ok, entry.state ?? null]), [[ids.b, true, null], ['checkout', true, null], [ids.broken, false, 'rolled-back'], [ids.b, true, null], [ids.broken, false, 'rolled-back'], [ids.liar, false, 'rolled-back']]);
  // A tampered version is refused before anything stops.
  writeFileSync(join(f.installRoot, 'versions', ids.liar, 'dist/lazy-extra.js'), '');
  assert.equal(f.tool('switch', ids.liar).json.code, 'DEV_RELEASE_MANIFEST_MISMATCH');
  assert.equal(f.describe().build.sourceCommit, b);
  const status = f.tool('status');
  assert.equal(status.json.current, ids.b); assert.equal(status.json.service.runsFromCheckout, false);
  assert.ok(status.json.versionUsers.some(entry => entry.id === ids.b));
});

test('a process started before a switch keeps loading its own version directory (real path, lazy import after the switch)', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const ids = ['one', 'two'].map(label => f.tool('stage', f.fake.commit(label)).json.id);
  assert.equal(f.tool('switch', ids[0]).status, 0);
  const client = spawn(process.execPath, [join(f.repo, '.agents/refactor/next-entry.mjs'), 'mcp'], { cwd: f.base, env: f.env, stdio: 'ignore' });
  let pid = null;
  for (let i = 0; i < 100 && !pid; i++) { await sleep(100); pid = readdirSync(join(f.repo, '.deckent')).find(name => name.startsWith('client-'))?.slice(7, -6); }
  assert.ok(pid, 'client started');
  const watcher = spawn('sh', ['-c', `while :; do readlink ${join(f.installRoot, 'current')} || echo MISSING; done`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let seen = ''; watcher.stdout.on('data', chunk => { seen += chunk; });
  assert.equal(f.tool('switch', ids[1]).status, 0);
  for (let i = 0; i < 50 && !seen.includes(`versions/${ids[1]}`); i++) await sleep(100);
  const closed = new Promise(done => watcher.once('close', done)); watcher.kill(); await closed;
  process.kill(Number(pid), 'SIGUSR2');
  let report = null;
  for (let i = 0; i < 100 && !report; i++) { await sleep(100); try { report = JSON.parse(readFileSync(join(f.repo, '.deckent', `lazy-${pid}.json`), 'utf8')); } catch { /* not yet */ } }
  assert.match(report.from, new RegExp(`/versions/${ids[0]}/dist/`), 'lazy module resolved from the version the process started with');
  assert.equal(seen.includes('MISSING'), false, 'current never missing during the switch');
  assert.ok(seen.includes(`versions/${ids[0]}`) && seen.includes(`versions/${ids[1]}`));
  client.kill();
});

test('rollback: pointer only when the ledger still fits; a migrated ledger needs --restore-ledger, a bound token and the existing ledger lock', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('v43')).json.id, next = f.tool('stage', f.fake.commit('v44', { ledger: 44 })).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const moved = f.tool('switch', next);
  assert.equal(moved.status, 0, moved.stdout);
  assert.equal(moved.json.ledgerBefore, 43); assert.equal(moved.json.ledgerAfter, 44);
  assert.match(moved.json.ledgerBackup, /state\/backups\/ledger-v43-.*\.db$/);
  // Writes after the upgrade: exactly what a restore would discard.
  const db = new DatabaseSync(f.ledger); for (let i = 0; i < 5; i++) db.prepare('INSERT INTO runs(note) VALUES (?)').run(`after-${i}`); db.close();

  const refused = f.tool('rollback');
  assert.equal(refused.json.code, 'DEV_RELEASE_LEDGER_AHEAD'); assert.equal(refused.json.ledger, 44); assert.equal(refused.json.targetOpens, 43);
  assert.equal(f.current(), `versions/${next}`); assert.ok(f.describe(), 'refusal changes nothing: the service still answers');

  const plan = f.tool('rollback', '--restore-ledger');
  assert.equal(plan.status, 3, plan.stdout); assert.equal(plan.json.code, 'DEV_RELEASE_CONFIRM_REQUIRED');
  assert.equal(plan.json.loss.rowsWrittenAfterBackup.runs, 5);
  assert.equal(plan.json.loss.ledgerVersion, 44); assert.equal(plan.json.loss.backupVersion, 43);
  assert.equal(f.describe(), null, 'the plan stops the service so the report is stable'); assert.equal(f.current(), `versions/${next}`);

  assert.equal(f.tool('rollback', '--restore-ledger', '--confirm', '0000000000000000').json.code, 'DEV_RELEASE_CONFIRM_STALE');
  // The lock file is never created by the tool: without it the restore is refused.
  renameSync(`${f.ledger}-lock`, `${f.ledger}-lock.away`);
  assert.equal(f.tool('rollback', '--restore-ledger', '--confirm', plan.json.token).json.code, 'DEV_RELEASE_LEDGER_LOCK_MISSING');
  assert.equal(existsSync(`${f.ledger}-lock`), false);
  renameSync(`${f.ledger}-lock.away`, `${f.ledger}-lock`);
  // A holder of the ledger custody (as the running service would be) blocks the restore.
  const holder = spawn('flock', [`${f.ledger}-lock`, 'sleep', '30'], { stdio: 'ignore', detached: true });
  await sleep(300);
  assert.equal(f.tool('rollback', '--restore-ledger', '--confirm', plan.json.token).json.code, 'DEV_RELEASE_SERVICE_UNREACHABLE');
  assert.throws(() => ledgerLock(`${f.ledger}-lock`), { code: 'DEV_RELEASE_LEDGER_BUSY' });
  process.kill(-holder.pid, 'SIGKILL'); await sleep(200);
  // A write after the report invalidates the confirmation.
  const later = new DatabaseSync(f.ledger); later.prepare('INSERT INTO runs(note) VALUES (?)').run('late'); later.close();
  const stale = f.tool('rollback', '--restore-ledger', '--confirm', plan.json.token);
  assert.equal(stale.json.code, 'DEV_RELEASE_CONFIRM_STALE'); assert.equal(stale.json.loss.rowsWrittenAfterBackup.runs, 6);
  const replan = f.tool('rollback', '--restore-ledger');
  const done = f.tool('rollback', '--restore-ledger', '--confirm', replan.json.token);
  assert.equal(done.status, 0, done.stdout);
  assert.equal(f.current(), `versions/${old}`); assert.equal(done.json.ledgerAfter, 43);
  assert.equal(done.json.restored.loss.rowsWrittenAfterBackup.runs, 6);
  assert.ok(done.json.restored.kept.some(path => /ledger-v44-rolledback-.*\.db$/.test(path)) && done.json.restored.kept.every(path => existsSync(path)));
  assert.equal(f.describe().build.sourceCommit, JSON.parse(readFileSync(join(f.installRoot, 'versions', old, 'release.json'), 'utf8')).sourceCommit);
  const check = new DatabaseSync(f.ledger, { readOnly: true }); assert.equal(check.prepare('SELECT count(*) AS c FROM runs').get().c, 0); check.close();
  // Same-schema rollback is a pointer move.
  assert.equal(f.tool('switch', next).json.ledgerAfter, 44);
});

test('prune lists only versions beyond the last three that no process uses; the tool refuses an install root inside the project', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'].map(label => f.tool('stage', f.fake.commit(label)).json.id);
  assert.equal(f.tool('switch', ids[0]).status, 0);
  const pruned = f.tool('prune');
  assert.deepEqual(pruned.json.candidates, [ids[1]]); // p1 is current (and in use), p3-p5 are the newest three
  assert.match(pruned.json.ownerCommand, /^rm -rf /);
  const inside = spawnSync(process.execPath, [join(f.repo, '.agents/refactor/dev-release.mjs'), 'status'], { env: { ...f.env, DECKENT_NEXT_INSTALL_ROOT: join(f.repo, '.deckent/versions') }, encoding: 'utf8' });
  assert.equal(JSON.parse(inside.stdout).code, 'DEV_RELEASE_INSTALL_ROOT_INSIDE_PROJECT');
});

// Sol U2-R1: a launcher that cannot be created (spawn ENOENT/EACCES/EAGAIN, reported asynchronously as an 'error' event) must become a typed,
// recorded failure that goes through the same discard / ledger-compatibility / pointer-rollback path as a service that exits.
test('launcher creation failure (ENOENT, EACCES, EAGAIN) is a typed, recorded failure: switch restores the pointer and old service, start and rollback refuse', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const ids = Object.fromEntries(['a', 'b'].map(label => [label, f.tool('stage', f.fake.commit(label)).json.id]));
  assert.equal(f.tool('switch', ids.a).status, 0);
  const L = layout({ env: { DECKENT_NEXT_INSTALL_ROOT: f.installRoot }, home: f.home, launcher: join(f.repo, '.agents/refactor/next-entry.mjs') });
  const base = { node: process.execPath, stopTimeoutMs: 20_000, startTimeoutMs: 20_000, waiveSmoke: [] };
  const nonExecutable = join(f.base, 'not-executable'); writeFileSync(nonExecutable, '#!/bin/sh\n', { mode: 0o644 });
  const failing = (kind, times = 1) => { let left = times; return (command, args, options) => {
    if (left-- <= 0) return spawn(command, args, options);
    if (kind === 'ENOENT') return spawn(join(f.base, 'missing-node'), args, options); // real spawn, real asynchronous ENOENT
    if (kind === 'EACCES') return spawn(nonExecutable, args, options); // real spawn, real asynchronous EACCES
    const child = new EventEmitter(); child.unref = () => undefined; // EAGAIN (fork limit) cannot be provoked safely: same event shape as Node
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN', errno: -11, syscall: 'spawn' })));
    return child; }; };
  const records = () => readFileSync(join(f.installRoot, 'switches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const launchers = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
    try { const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); return argv.includes(`${f.repo}/.agents/refactor/next-entry.mjs`) && argv.includes('serve'); } catch { return false; } });
  const serviceA = f.describe(); assert.equal(serviceA.build.sourceCommit, JSON.parse(readFileSync(join(f.installRoot, 'versions', ids.a, 'release.json'), 'utf8')).sourceCommit);

  for (const kind of ['ENOENT', 'EACCES', 'EAGAIN']) {
    await assert.rejects(switchTo(L, ids.b, { ...base, spawn: failing(kind) }), error => {
      assert.equal(error.code, 'DEV_RELEASE_SWITCH_FAILED'); assert.equal(error.detail.reason, `launcher failed: ${kind}`);
      assert.equal(error.detail.pointer, ids.a); assert.equal(error.detail.previousService.ok, true); return true; });
    assert.equal(f.current(), `versions/${ids.a}`, `${kind}: pointer restored`);
    assert.equal(f.describe().build.sourceCommit, serviceA.build.sourceCommit, `${kind}: old service serves again`);
    const last = records().at(-1);
    assert.deepEqual([last.to, last.ok, last.state, last.launchError], [ids.b, false, 'rolled-back', kind]);
    assert.equal(launchers().length, 1, `${kind}: only the restored service's launcher runs, no orphan`);
  }
  assert.equal(records().some(entry => entry.to === ids.b && entry.ok), false, 'no success record for the failed target');

  // start: the service is down and the launcher cannot be created → typed refusal, nothing left running.
  const running = f.describe();
  assert.equal(f.cli('runtime', 'shutdown', '--service', 'runtime', '--instance', running.instanceId, '--command-id', 'test-stop', '--reason', 'test', '--json').status, 0);
  for (let i = 0; i < 100 && (f.describe() || launchers().length); i++) await sleep(100);
  assert.equal(launchers().length, 0, 'service and its launcher gone before start');
  await assert.rejects(start(L, { ...base, spawn: failing('ENOENT') }), error => error.code === 'DEV_RELEASE_START_FAILED' && error.detail.launchError === 'ENOENT');
  assert.equal(f.describe(), null); assert.equal(launchers().length, 0);
  assert.equal(f.tool('start').status, 0);

  // rollback on the same error path: pointer moved to the target as asked, typed refusal, failed record; `start` recovers.
  assert.equal(f.tool('switch', ids.b).status, 0);
  await assert.rejects(rollback(L, { ...base, spawn: failing('EAGAIN') }), error => error.code === 'DEV_RELEASE_START_FAILED' && error.launchError === undefined && error.detail.launchError === 'EAGAIN');
  const failedRollback = records().at(-1);
  assert.deepEqual([failedRollback.action, failedRollback.to, failedRollback.ok, failedRollback.launchError], ['rollback', ids.a, false, 'EAGAIN']);
  assert.equal(f.current(), `versions/${ids.a}`); assert.equal(f.describe(), null); assert.equal(launchers().length, 0);
  assert.equal(f.tool('start').json.service.build.sourceCommit, serviceA.build.sourceCommit);
});

test('a new version that migrates the ledger and then fails keeps the old code closed (operator required), unchanged by U2-R1', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('v43')).json.id, bad = f.tool('stage', f.fake.commit('v44-exits', { ledger: 44, behavior: { serveExit: true } })).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const failed = f.tool('switch', bad);
  assert.equal(failed.json.code, 'DEV_RELEASE_OPERATOR_REQUIRED', failed.stdout); assert.equal(failed.json.ledgerNow, 44);
  assert.equal(f.describe(), null, 'the old v43 code is not started on a v44 ledger');
  assert.equal(f.current(), `versions/${bad}`);
  const last = readFileSync(join(f.installRoot, 'switches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.deepEqual([last.to, last.ok, last.state], [bad, false, 'operator-required']);
});

test('package version: a second stage with the live version is refused, waivable, bumped passes, missing version is recorded as null', { skip: process.platform !== 'linux' && 'requires Linux /proc process custody and util-linux flock' }, async t => {
  const f = fixture(); t.after(f.cleanup);
  const versions = () => readdirSync(join(f.installRoot, 'versions')).sort();
  const releaseOf = r => JSON.parse(readFileSync(join(f.installRoot, 'versions', r.json.id, 'release.json'), 'utf8'));
  const live = f.tool('stage', f.fake.commit('live', { version: '1.0.0-alpha.7' })); assert.equal(live.status, 0, live.stdout + live.stderr);
  assert.equal(f.tool('switch', live.json.id).status, 0);
  const same = f.fake.commit('same', { version: '1.0.0-alpha.7' }), before = versions();
  const refused = f.tool('stage', same);
  assert.equal(refused.status, 1); assert.equal(refused.json.code, 'DEV_RELEASE_SAME_VERSION');
  assert.equal(refused.json.version, '1.0.0-alpha.7'); assert.equal(refused.json.currentId, live.json.id);
  assert.deepEqual(versions(), before);
  const waived = f.tool('stage', same, '--allow-same-version'); assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  assert.equal(releaseOf(waived).sameVersionWaived, true); assert.equal(releaseOf(waived).packageVersion, '1.0.0-alpha.7');
  const bumped = f.tool('stage', f.fake.commit('bumped', { version: '1.0.0-alpha.8' })); assert.equal(bumped.status, 0, bumped.stdout + bumped.stderr);
  assert.equal(releaseOf(bumped).sameVersionWaived, false); assert.equal(releaseOf(bumped).packageVersion, '1.0.0-alpha.8');
  const bare = f.tool('stage', f.fake.commit('bare', { version: null })); assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.equal(releaseOf(bare).packageVersion, null); assert.equal(releaseOf(bare).sameVersionWaived, false);
});
