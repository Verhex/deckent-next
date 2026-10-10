import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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


function releaseTest(name, fn) {
  const reason = process.platform !== 'linux' && 'DEV_RELEASE_PLATFORM_UNSUPPORTED: Linux /proc process custody and util-linux flock are required';
  if (reason) console.log('verify-not-run: ' + JSON.stringify({ file: '.agents/refactor/dev-release.test.mjs', test: name, state: 'skipped', reason }));
  return test(name, { skip: reason }, fn);
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-release-')));
  const repo = join(base, 'checkout'), home = join(base, 'home'), data = join(base, 'data'), bwrap = join(base, 'bwrap');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(join(bwrap, 'out'), { recursive: true });
  const fake = fakeRepository(repo, join(base, 'origin.git'));
  mkdirSync(join(repo, '.agents/refactor'), { recursive: true });
  for (const name of ['dev-release.mjs', 'dev-release-service.mjs', 'next-entry.mjs']) copyFileSync(join(here, name), join(repo, '.agents/refactor', name));
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
    if (process.platform === 'linux') for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(base) && Number(pid) !== process.pid) process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(base, { recursive: true, force: true });
  };
  return { base, repo, home, data, env, installRoot, fake, tool, cli, describe, ledger, cleanup, current: () => { try { return readlinkSync(join(installRoot, 'current')); } catch { return null; } } };
}
const refsHash = repo => execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' }) + readdirSync(join(repo, '.git')).sort().join(',');
const jsonAt = path => JSON.parse(readFileSync(path, 'utf8'));
const appendBuild = (f, code) => { const path = join(f.repo, 'scripts/build.mjs'); writeFileSync(path, readFileSync(path, 'utf8') + '\n' + code + '\n'); };

releaseTest('origin identity survives staging, including preview and allow-local, instead of naming the build clone', t => {
  const f = fixture(); t.after(f.cleanup);
  f.env.DECKENT_BUILD_SOURCE_COMMON_DIR = join(f.base, 'inherited-wrong-origin');
  for (const flag of [null, '--preview', '--allow-local']) {
    const sha = f.fake.commit(`origin-${flag}`, { push: flag === null });
    const staged = f.tool('stage', sha, '--keep-build', ...(flag ? [flag] : []));
    assert.equal(staged.status, 0, staged.stdout + staged.stderr);
    const origin = realpathSync(join(f.repo, '.git'));
    const dir = join(f.installRoot, 'versions', staged.json.id);
    const identity = jsonAt(join(dir, 'dist/build-identity.json')), release = jsonAt(join(dir, 'release.json'));
    assert.equal(identity.sourceCommonDir, origin);
    assert.equal(identity.sourceCommonDirOrigin, 'declared'); assert.equal(identity.sourceCommit, sha);
    assert.equal(release.sourceCommonDir, origin); assert.deepEqual(release.identity, identity);
    const build = readdirSync(join(f.installRoot, 'build')).find(name => name.startsWith(sha.slice(0, 12)));
    assert.notEqual(identity.sourceCommonDir, realpathSync(join(f.installRoot, 'build', build, '.git')));
    assert.equal(release.preview, flag === '--preview'); assert.equal(release.local, flag === '--allow-local');
    assert.equal(f.current(), null);
  }
});

releaseTest('origin follows --source through a symlinked linked worktree, independently of the launcher checkout', t => {
  const f = fixture(); t.after(f.cleanup); f.fake.commit('launcher');
  const source = join(f.base, 'other source'), other = fakeRepository(source, join(f.base, 'other-origin.git'));
  const sha = other.commit('origin'); const linked = join(f.base, 'linked'), alias = join(f.base, 'source alias');
  other.git('worktree', 'add', '--quiet', '--detach', linked, sha); symlinkSync(linked, alias, 'dir');
  const before = refsHash(source), staged = f.tool('stage', sha, '--source', alias);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const identity = jsonAt(join(staged.json.dir, 'dist/build-identity.json'));
  assert.equal(identity.sourceCommonDir, realpathSync(join(source, '.git')));
  assert.notEqual(identity.sourceCommonDir, realpathSync(join(f.repo, '.git')));
  assert.equal(refsHash(source), before);
});

releaseTest('invalid declared origin fails the fake producer and stage installs nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const path = join(f.repo, 'scripts/build.mjs'), invalid = join(f.base, 'missing-origin');
  writeFileSync(path, `process.env.DECKENT_BUILD_SOURCE_COMMON_DIR = ${JSON.stringify(invalid)};\n` + readFileSync(path, 'utf8'));
  const sha = f.fake.commit('invalid-origin'), staged = f.tool('stage', sha);
  assert.equal(staged.status, 1, staged.stdout + staged.stderr);
  assert.equal(staged.json.code, 'DEV_RELEASE_BUILD'); assert.match(staged.json.stderr, /BUILD_SOURCE_COMMON_DIR_INVALID/);
  assert.deepEqual(readdirSync(join(f.installRoot, 'versions')), []);
  assert.deepEqual(readdirSync(join(f.installRoot, 'build')), []); assert.equal(f.current(), null);
});

releaseTest('identity mismatch refuses staging without changing the previous current', t => {
  const f = fixture(); t.after(f.cleanup);
  const good = f.tool('stage', f.fake.commit('good-origin')); assert.equal(good.status, 0, good.stdout);
  symlinkSync(`versions/${good.json.id}`, join(f.installRoot, 'current'));
  const path = join(f.repo, 'scripts/build.mjs'), original = readFileSync(path, 'utf8');
  for (const [name, change] of Object.entries({ common: "identity.sourceCommonDir = process.cwd() + '/.git';",
    commit: "identity.sourceCommit = '0'.repeat(40);", missing: 'delete identity.sourceCommonDir;',
    malformed: "writeFileSync('dist/build-identity.json', '{bad json');", absent: "rmSync('dist/build-identity.json');" })) {
    writeFileSync(path, original);
    appendBuild(f, `const identity = JSON.parse(readFileSync('dist/build-identity.json', 'utf8'));\n${name === 'malformed' || name === 'absent' ? change : change + "\nwriteFileSync('dist/build-identity.json', JSON.stringify(identity));"}`);
    const sha = f.fake.commit(`mismatch-${name}`), staged = f.tool('stage', sha);
    assert.equal(staged.status, 1, staged.stdout + staged.stderr);
    assert.equal(staged.json.code, 'DEV_RELEASE_IDENTITY_MISMATCH', staged.stdout);
    assert.deepEqual(readdirSync(join(f.installRoot, 'versions')), [good.json.id]);
    assert.deepEqual(readdirSync(join(f.installRoot, 'build')), []);
    assert.equal(f.current(), `versions/${good.json.id}`);
  }
});

test('fake build producer honours derived, declared and invalid origins using the real producer', t => {
  const f = fixture(); t.after(f.cleanup); f.fake.commit('fake-provenance');
  const env = { ...f.env }; delete env.DECKENT_BUILD_SOURCE_COMMON_DIR;
  const build = () => spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: f.repo, env, encoding: 'utf8' });
  assert.equal(build().status, 0);
  assert.equal(jsonAt(join(f.repo, 'dist/build-identity.json')).sourceCommonDirOrigin, 'derived');
  const alias = join(f.base, 'origin alias'); symlinkSync(join(f.repo, '.git'), alias, 'dir');
  env.DECKENT_BUILD_SOURCE_COMMON_DIR = alias;
  assert.equal(build().status, 0);
  const declared = jsonAt(join(f.repo, 'dist/build-identity.json'));
  assert.equal(declared.sourceCommonDir, realpathSync(alias)); assert.equal(declared.sourceCommonDirOrigin, 'declared');
  env.DECKENT_BUILD_SOURCE_COMMON_DIR = join(f.base, 'missing');
  const invalid = build(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /BUILD_SOURCE_COMMON_DIR_INVALID/);
  assert.equal(existsSync(join(f.repo, 'dist/build-identity.json')), false);
  assert.equal(readFileSync(join(f.repo, 'scripts/build-identity.mjs'), 'utf8'), readFileSync(join(here, '../../scripts/build-identity.mjs'), 'utf8'));
});

releaseTest('stage origin ignores inherited Git common-dir overrides', t => {
  const f = fixture(); t.after(f.cleanup); const sha = f.fake.commit('git-env');
  f.env.GIT_COMMON_DIR = join(f.base, 'origin.git');
  const staged = f.tool('stage', sha);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  assert.equal(staged.json.release.sourceCommonDir, realpathSync(join(f.repo, '.git')));
});

releaseTest('stage refuses a mismatched packaged origin and a stale cached identity', t => {
  const f = fixture(); t.after(f.cleanup); const sha = f.fake.commit('cached');
  const good = f.tool('stage', sha); assert.equal(good.status, 0, good.stdout);
  symlinkSync(`versions/${good.json.id}`, join(f.installRoot, 'current'));
  const cachedPath = join(good.json.dir, 'dist/build-identity.json'), cached = jsonAt(cachedPath);
  writeFileSync(cachedPath, JSON.stringify({ ...cached, sourceCommonDir: '/wrong-origin' }));
  const reused = f.tool('stage', sha);
  assert.equal(reused.json.code, 'DEV_RELEASE_IDENTITY_MISMATCH', reused.stdout);
  const pack = join(f.repo, 'scripts/build-dist.mjs');
  const original = readFileSync(pack, 'utf8');
  const marker = "writeFileSync(join(stage, 'package.json')";
  const poison = "const identityPath = join(stage, 'dist/build-identity.json'); const identity = JSON.parse(readFileSync(identityPath, 'utf8')); identity.sourceCommonDir = '/wrong-packaged-origin'; writeFileSync(identityPath, JSON.stringify(identity));\n";
  assert.ok(original.includes(marker)); writeFileSync(pack, original.replace(marker, poison + marker));
  const bad = f.tool('stage', f.fake.commit('bad-package-origin'));
  assert.equal(bad.json.code, 'DEV_RELEASE_IDENTITY_MISMATCH', bad.stdout);
  assert.deepEqual(readdirSync(join(f.installRoot, 'versions')), [good.json.id]);
  assert.deepEqual(readdirSync(join(f.installRoot, 'build')), []);
  assert.equal(f.current(), `versions/${good.json.id}`);
});

async function startFromLauncher(f) {
  const child = spawn(process.execPath, [join(f.repo, '.agents/refactor/next-entry.mjs'), 'cli', 'runtime', 'serve', '--json'], { cwd: f.base, env: f.env, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 100; i++) { const d = f.describe(); if (d) return d; await sleep(100); }
  throw new Error('fake service did not start');
}

releaseTest('stage builds the exact pushed commit outside the source repository and refuses unknown, dirty, unpushed, unsmoked and sandbox-less input', async t => {
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

releaseTest('switch stops the running service through its own CLI, moves the pointer atomically and starts the new version; a failed start rolls the pointer back', async t => {
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

releaseTest('a process started before a switch keeps loading its own version directory (real path, lazy import after the switch)', async t => {
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

releaseTest('rollback: pointer only when the ledger still fits; a migrated ledger needs --restore-ledger, a bound token and the existing ledger lock', async t => {
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

releaseTest('prune lists only versions beyond the last three that no process uses; the tool refuses an install root inside the project', async t => {
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
releaseTest('launcher creation failure (ENOENT, EACCES, EAGAIN) is a typed, recorded failure: switch restores the pointer and old service, start and rollback refuse', async t => {
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

releaseTest('a new version that migrates the ledger and then fails keeps the old code closed (operator required), unchanged by U2-R1', async t => {
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

releaseTest('package version: a second stage with the live version is refused, waivable, bumped passes, missing version is recorded as null', async t => {
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
  // Sol 2273 P2: an inherited GIT_DIR must not blind the same-version check (the package.json lookup runs with the tool's clean git environment).
  const inherited = spawnSync(process.execPath, [join(f.repo, '.agents/refactor/dev-release.mjs'), 'stage', same, '--bwrap', join(f.base, 'bwrap'), '--start-timeout-ms', '20000', '--stop-timeout-ms', '20000'],
    { cwd: f.base, env: { ...f.env, GIT_DIR: '/definitely-missing-git-dir' }, encoding: 'utf8', timeout: 180_000 });
  assert.equal(inherited.status, 1, inherited.stdout + inherited.stderr); assert.equal(JSON.parse(inherited.stdout).code, 'DEV_RELEASE_SAME_VERSION');
  assert.deepEqual(versions(), before);
  const waived = f.tool('stage', same, '--allow-same-version'); assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  assert.equal(releaseOf(waived).sameVersionWaived, true); assert.equal(releaseOf(waived).packageVersion, '1.0.0-alpha.7');
  const bumped = f.tool('stage', f.fake.commit('bumped', { version: '1.0.0-alpha.8' })); assert.equal(bumped.status, 0, bumped.stdout + bumped.stderr);
  assert.equal(releaseOf(bumped).sameVersionWaived, false); assert.equal(releaseOf(bumped).packageVersion, '1.0.0-alpha.8');
  const bare = f.tool('stage', f.fake.commit('bare', { version: null })); assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.equal(releaseOf(bare).packageVersion, null); assert.equal(releaseOf(bare).sameVersionWaived, false);
});

for (const [oldPath, nextPath] of [['legacy', 'private-tmp'], ['private-tmp', 'legacy']]) {
  releaseTest(`socket migration ${oldPath} → ${nextPath}: hidden service is stopped through its own CLI before replacement`, async t => {
    const f = fixture(); t.after(f.cleanup);
    const old = f.tool('stage', f.fake.commit('old-path', { behavior: { socketPath: oldPath } })).json.id;
    assert.equal(f.tool('switch', old).status, 0);
    const before = f.describe();
    const client = f.tool('stage', f.fake.commit('new-client', { behavior: { socketPath: nextPath } })).json.id;
    const target = f.tool('stage', f.fake.commit('target', { behavior: { socketPath: nextPath } })).json.id;
    // The pointer/client has advanced while the previous release's process still owns the ledger.
    rmSync(join(f.installRoot, 'current')); symlinkSync(`versions/${client}`, join(f.installRoot, 'current'));
    assert.equal(f.describe(), null, 'new client cannot see the old socket');
    assert.throws(() => ledgerLock(`${f.ledger}-lock`), { code: 'DEV_RELEASE_LEDGER_BUSY' });
    assert.equal(f.tool('status').json.service.processId, before.processId);
    assert.equal(f.tool('start').json.already, true, 'no second runtime while the old one is present');
    const switched = f.tool('switch', target);
    assert.equal(switched.status, 0, switched.stdout + switched.stderr);
    assert.equal(switched.json.fromBuild.sourceCommit, before.build.sourceCommit);
    assert.equal(switched.json.stoppedVia, join(f.installRoot, 'versions', old, 'dist/composition/core/cli/internal/entry.js'));
    const shutdown = JSON.parse(readFileSync(join(f.data, 'state/shutdowns.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(shutdown.instanceId, before.instanceId); assert.equal(shutdown.commandId, switched.json.shutdownCommandId);
    assert.equal(shutdown.via, switched.json.stoppedVia);
    assert.equal(existsSync(`/proc/${before.processId}`), false);
    assert.notEqual(switched.json.service.processId, before.processId);
    assert.equal(f.current(), `versions/${target}`);
  });
}

releaseTest('unidentified ledger holder blocks a switch instead of starting a replacement', async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('old')).json.id, next = f.tool('stage', f.fake.commit('next')).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const service = f.describe();
  assert.equal(f.cli('runtime', 'shutdown', '--service', 'runtime', '--instance', service.instanceId, '--command-id', 'test-unidentified', '--reason', 'test', '--json').status, 0);
  for (let i = 0; i < 100 && existsSync(`/proc/${service.processId}`); i++) await sleep(50);
  const holder = spawn('flock', [`${f.ledger}-lock`, process.execPath, '-e', 'setInterval(() => {}, 1000)', f.base], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* fixture gone */ } });
  let held = false;
  for (let i = 0; i < 100 && !held; i++) { await sleep(50); try { ledgerLock(`${f.ledger}-lock`)(); } catch (error) { held = error.code === 'DEV_RELEASE_LEDGER_BUSY'; } }
  assert.equal(held, true);
  const refused = f.tool('switch', next);
  assert.equal(refused.json.code, 'DEV_RELEASE_SERVICE_UNREACHABLE', refused.stdout);
  assert.equal(f.current(), `versions/${old}`); assert.equal(f.describe(), null);
});

// Fake manager I/O drives real temporary runtime processes. No user manager or live/N1 unit is contacted.
function managedFixture(f) {
  const calls = [], group = '/user.slice/user-1000.slice/user@1000.service/app.slice/deckent-n1.service';
  let properties = {}, failures = 0;
  const opts = { node: process.execPath, stopTimeoutMs: 20_000, startTimeoutMs: 20_000, waiveSmoke: [],
    spawn: () => { throw new Error('raw launch forbidden for managed service'); },
    readCgroup: () => `0::${group}\n`,
    systemctl: args => {
      calls.push(args);
      assert.equal(args[0], '--user'); assert.equal(args[2], 'deckent-n1.service');
      if (args[1] === 'show') {
        const pid = f.describe()?.processId ?? 0;
        return { status: 0, stdout: Object.entries({ LoadState: 'loaded', WorkingDirectory: f.repo, ControlGroup: group,
          MainPID: pid, UMask: '0022', Restart: 'on-failure', ExecStart: `{ path=${process.execPath} ; argv[]=${process.execPath} ${f.repo}/.agents/refactor/next-entry.mjs cli runtime serve --json ; }`,
          Environment: `DECKENT_NEXT_INSTALL_ROOT=${f.installRoot}`, ...properties }).map(([key, value]) => `${key}=${value}`).join('\n') };
      }
      if (args[1] === 'restart') {
        assert.equal(f.describe(), null, 'governed shutdown completes before restart');
        ledgerLock(`${f.ledger}-lock`)();
        if (failures-- > 0) return { status: 1, stderr: 'injected systemctl failure' };
        const child = spawn(process.execPath, [join(f.repo, '.agents/refactor/next-entry.mjs'), 'cli', 'runtime', 'serve', '--json'],
          { cwd: f.repo, env: f.env, detached: true, stdio: 'ignore' });
        child.unref(); return { status: 0, stdout: '' };
      }
      if (args[1] === 'stop') { assert.equal(f.describe(), null); return { status: 0, stdout: '' }; }
      throw new Error(`unexpected systemctl command: ${args.join(' ')}`);
    } };
  const L = layout({ env: { DECKENT_NEXT_INSTALL_ROOT: f.installRoot }, home: f.home, launcher: join(f.repo, '.agents/refactor/next-entry.mjs') });
  return { L, opts, calls, setProperties: value => { properties = value; }, failRestarts: n => { failures = n; } };
}

releaseTest('managed switch, rollback and stopped-service recovery use systemctl --user restart, with governed shutdown receipts', async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('systemd-old')).json.id, next = f.tool('stage', f.fake.commit('systemd-next')).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const before = f.describe(), manager = managedFixture(f);
  const switched = await switchTo(manager.L, next, manager.opts);
  assert.equal(switched.serviceManager, 'deckent-n1.service'); assert.notEqual(switched.service.instanceId, before.instanceId);
  assert.equal(f.current(), `versions/${next}`);
  const rolled = await rollback(manager.L, manager.opts);
  assert.equal(rolled.serviceManager, 'deckent-n1.service'); assert.equal(f.current(), `versions/${old}`);
  const running = f.describe();
  assert.equal(f.cli('runtime', 'shutdown', '--service', 'runtime', '--instance', running.instanceId, '--command-id', 'test-managed-stop', '--reason', 'test', '--json').status, 0);
  for (let i = 0; i < 100 && existsSync(`/proc/${running.processId}`); i++) await sleep(50);
  assert.equal((await start(manager.L, manager.opts)).ok, true);
  assert.deepEqual(manager.calls.filter(args => args[1] !== 'show'), Array.from({ length: 3 }, () => ['--user', 'restart', 'deckent-n1.service']));
  const receipts = readFileSync(join(f.data, 'state/shutdowns.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(receipts[0].commandId, switched.shutdownCommandId); assert.equal(receipts[1].commandId, rolled.shutdownCommandId);
});

releaseTest('managed restart failure rolls back through systemd without a raw launch', async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('systemd-old')).json.id, next = f.tool('stage', f.fake.commit('systemd-next')).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const before = f.describe(), manager = managedFixture(f); manager.failRestarts(1);
  await assert.rejects(switchTo(manager.L, next, manager.opts), error => {
    assert.equal(error.code, 'DEV_RELEASE_SWITCH_FAILED'); assert.equal(error.detail.launchError, 'SYSTEMCTL_RESTART_FAILED');
    assert.equal(error.detail.previousService.ok, true); return true;
  });
  assert.equal(f.current(), `versions/${old}`); assert.equal(f.describe().build.sourceCommit, before.build.sourceCommit);
  assert.equal(manager.calls.filter(args => args[1] === 'restart').length, 2);
});

releaseTest('invalid unit custody, umask and automatic clean-exit restart refuse before shutdown or pointer changes', async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('systemd-old')).json.id, next = f.tool('stage', f.fake.commit('systemd-next')).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const before = f.describe(), manager = managedFixture(f);
  for (const properties of [{ UMask: '0077' }, { Restart: 'always' }, { WorkingDirectory: f.home }, { ControlGroup: '/foreign/deckent-n1.service' },
    { ExecStart: '/foreign/entry.js cli runtime serve' }, { Environment: 'DECKENT_NEXT_INSTALL_ROOT=/foreign/install' }]) {
    manager.setProperties(properties);
    await assert.rejects(switchTo(manager.L, next, manager.opts), error => error.code === 'DEV_RELEASE_SYSTEMD_CUSTODY_INVALID');
    assert.equal(f.current(), `versions/${old}`); assert.equal(f.describe().instanceId, before.instanceId);
    assert.equal(existsSync(join(f.data, 'state/shutdowns.jsonl')), false);
  }
  assert.equal(manager.calls.some(args => args[1] === 'restart'), false);
});

releaseTest('unavailable systemd control refuses before governed shutdown; no raw fallback', async t => {
  const f = fixture(); t.after(f.cleanup);
  const old = f.tool('stage', f.fake.commit('systemd-old')).json.id, next = f.tool('stage', f.fake.commit('systemd-next')).json.id;
  assert.equal(f.tool('switch', old).status, 0);
  const before = f.describe(), manager = managedFixture(f);
  manager.opts.systemctl = () => ({ status: null, error: { code: 'ENOENT' } });
  await assert.rejects(switchTo(manager.L, next, manager.opts), error => error.code === 'DEV_RELEASE_SYSTEMD_UNAVAILABLE');
  assert.equal(f.current(), `versions/${old}`); assert.equal(f.describe().instanceId, before.instanceId);
  assert.equal(existsSync(join(f.data, 'state/shutdowns.jsonl')), false);
});
