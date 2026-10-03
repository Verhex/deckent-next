// Test fixture for dev-release.test.mjs / next-entry.test.mjs: a tiny fake Deckent source repository whose scripts keep the argv and output
// contracts of the real ones (scripts/build.mjs → dist/build-identity.json; build-dist.mjs --out --pack --bwrap → JSON with publishable,
// bubblewrap, packed; pack-smoke.mjs <tarball>|--root → JSON report, exit 1 on failure) and whose "product" CLI implements the runtime
// subset dev-release drives: `runtime serve --json` (ledger lock via flock on <ledger>-lock, forward-only ledger upgrade with a VACUUM INTO
// backup and a ledger-upgraded event, ready event), `runtime describe --json` and governed `runtime shutdown`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FAKE_ENTRY = String.raw`#!/usr/bin/env node
import { appendFileSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), dist = resolve(here, '../../../..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const identity = read(join(dist, 'build-identity.json')), behavior = read(join(dist, 'behavior.json'));
const LEDGER = Number(/CURRENT_LEDGER_VERSION = (\d+)/.exec(readFileSync(join(dist, 'adapters/core/sqlite-ledger/internal/schema.js'), 'utf8'))[1]);
const args = process.argv.slice(2), out = value => process.stdout.write(JSON.stringify(value) + '\n');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
if (here.endsWith('/mcp/internal')) {
  // A long-lived client (like an MCP server a host keeps open): on SIGUSR2 it lazily imports a module and reports where it came from.
  const report = join(process.cwd(), '.deckent', 'lazy-' + process.pid + '.json');
  const keep = setInterval(() => undefined, 1000);
  process.on('SIGUSR2', async () => { const lazy = await import('./lazy.js'); writeFileSync(report, JSON.stringify({ from: lazy.where })); clearInterval(keep); });
  writeFileSync(join(process.cwd(), '.deckent', 'client-' + process.pid + '.ready'), '');
} else if (args[0] === '--version') { out('deckent v0.0.0 ' + identity.sourceCommit.slice(0, 8)); }
else {
  const config = read(join(process.cwd(), '.deckent/config.json')), state = join(config.layout.root, 'state');
  const ledger = join(state, 'ledger.db'), service = join(state, 'fake-service.json'), backups = join(state, 'backups');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const current = () => { try { const s = read(service); return alive(s.pid) ? s : null; } catch { return null; } };
  if (args[0] === 'runtime' && args[1] === 'serve') {
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const fd = openSync(ledger + '-lock', constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status !== 0) { process.stderr.write('LOCAL_RUNTIME_ALREADY_RUNNING\n'); process.exit(1); }
    const db = new DatabaseSync(ledger), version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > LEDGER) { process.stderr.write('ATTEMPT_STORE_VERSION\n'); process.exit(1); }
    if (version > 0 && version < LEDGER) {
      const backup = join(backups, 'ledger-v' + version + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
      db.exec("VACUUM INTO '" + backup + "'"); chmodSync(backup, 0o600);
      out({ schemaVersion: 1, event: 'ledger-upgraded', from: version, to: LEDGER, backupPath: backup });
    }
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, note TEXT); CREATE TABLE IF NOT EXISTS service_shutdowns(command_id TEXT);'
      + (LEDGER > 43 ? ' CREATE TABLE IF NOT EXISTS v' + LEDGER + '_things(x);' : '') + ' PRAGMA user_version=' + LEDGER + ';');
    db.close(); chmodSync(ledger, 0o600);
    if (behavior.serveExit) { process.stderr.write('FAKE_SERVE_EXIT\n'); process.exit(1); }
    const build = behavior.wrongBuild ? { sourceTreeSha256: '0'.repeat(64), sourceCommit: '0'.repeat(40) } : { sourceTreeSha256: identity.sourceTreeSha256, sourceCommit: identity.sourceCommit };
    writeFileSync(service, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), build }), { mode: 0o600 });
    out({ schemaVersion: 1, event: 'ready', endpoint: 'fake' });
    const keep = setInterval(() => undefined, 1000);
    process.on('SIGTERM', () => { clearInterval(keep); try { if (read(service).pid === process.pid) unlinkSync(service); } catch {} closeSync(fd); out({ schemaVersion: 1, event: 'stopped' }); process.exit(0); });
  } else if (args[0] === 'runtime' && args[1] === 'describe') {
    const s = current(); if (!s) { process.stderr.write('LOCAL_RUNTIME_UNAVAILABLE\n'); process.exit(1); }
    out({ schemaVersion: 1, instanceId: s.instanceId, shutdownAvailable: true, identity: { scopeId: 'fake-scope', serviceId: 'runtime' }, build: s.build, processId: s.pid });
  } else if (args[0] === 'runtime' && args[1] === 'shutdown') {
    const s = current(), field = name => args[args.indexOf(name) + 1];
    if (!s || field('--instance') !== s.instanceId || field('--service') !== 'runtime' || !field('--command-id')) { process.stderr.write('SERVICE_SHUTDOWN_INVALID\n'); process.exit(1); }
    const db = new DatabaseSync(ledger); db.prepare('INSERT INTO service_shutdowns VALUES (?)').run(field('--command-id')); db.close();
    appendFileSync(join(state, 'shutdowns.jsonl'), JSON.stringify({ commandId: field('--command-id'), instanceId: s.instanceId, via: fileURLToPath(import.meta.url) }) + '\n');
    process.kill(s.pid, 'SIGTERM'); out({ schemaVersion: 1, admitted: true });
  } else { process.stderr.write('CLI_USAGE\n'); process.exit(2); }
}
`;

const BUILD = String.raw`import { writeBuildIdentity } from './build-identity.mjs';
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };
rmSync('dist', { recursive: true, force: true });
const behavior = JSON.parse(readFileSync('src/behavior.json', 'utf8'));
if (behavior.dirtyOnBuild) appendFileSync('src/behavior.json', ' ');
const files = walk('src').sort();
for (const file of files) {
  const target = join('dist', relative('src', file).replace(/\.ts$/, '.js')); mkdirSync(dirname(target), { recursive: true }); cpSync(file, target); }
for (const surface of ['cli', 'mcp']) { const dir = join('dist/composition/core', surface, 'internal'); mkdirSync(dir, { recursive: true });
  cpSync('src/fake-entry.js', join(dir, 'entry.js')); cpSync('src/lazy.js', join(dir, 'lazy.js')); }
writeBuildIdentity(process.cwd(), files.map(file => resolve(file)), resolve('dist'));
process.stdout.write('build ok (fake)\n');
`;

const BUILD_DIST = String.raw`import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2), opt = name => { const at = args.indexOf(name); return at > -1 ? args[at + 1] : undefined; };
const out = resolve(opt('--out')), bwrap = opt('--bwrap'), stage = join(out, 'package');
rmSync(out, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
cpSync('dist', join(stage, 'dist'), { recursive: true });
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'deckent', version: '0.0.0', type: 'module' }));
const behavior = JSON.parse(readFileSync('src/behavior.json', 'utf8'));
const summary = { schemaVersion: 1, stage, publishable: { ok: !behavior.unpublishable, blockers: behavior.unpublishable ? ['fake blocker'] : [] }, bubblewrap: { shipped: Boolean(bwrap) && !behavior.bwrapMissing } };
let packed = null;
if (args.includes('--pack')) { const tarball = join(out, 'deckent-0.0.0.tgz'); execFileSync('tar', ['-czf', tarball, '-C', out, 'package']);
  packed = { tarball, size: statSync(tarball).size, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') }; }
process.stdout.write(JSON.stringify({ ...summary, packed }, null, 2) + '\n');
`;

const PACK_SMOKE = String.raw`import { readFileSync } from 'node:fs';
const behavior = JSON.parse(readFileSync('src/behavior.json', 'utf8')), failing = behavior.smokeFail === true;
const report = { node: process.version, checks: { version: { ok: true }, runtime: { ok: !failing } } };
report.ok = !failing; process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = failing ? 1 : 0;
`;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=fake', '-c', 'user.email=fake@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

/** A git repository at `root` with a bare `origin`; returns helpers to commit product variants. */
export function fakeRepository(root, origin) {
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  put(root, 'package.json', JSON.stringify({ name: 'deckent', version: '0.0.0', private: true, type: 'module' }));
  put(root, 'package-lock.json', JSON.stringify({ name: 'deckent', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'deckent', version: '0.0.0' } } }));
  put(root, '.gitignore', 'dist/\nnode_modules/\n.deckent/\n.pack/\n.agents/\n');
  // Share the real provenance producer: the fake build copies tiny fixtures, never compiles product code.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../../scripts/build-identity.mjs', import.meta.url)), join(root, 'scripts/build-identity.mjs'));
  put(root, 'scripts/build.mjs', BUILD); put(root, 'scripts/build-dist.mjs', BUILD_DIST); put(root, 'scripts/pack-smoke.mjs', PACK_SMOKE);
  put(root, 'src/fake-entry.js', FAKE_ENTRY); put(root, 'src/lazy.js', 'export const where = import.meta.url;\n');
  put(root, 'src/engine/core/runtime/internal/service-protocol.ts', 'export const RUNTIME_SERVICE_SCHEMA_VERSION = 18 as const;\n');
  git(root, 'remote', 'add', 'origin', origin);
  /** Commit a variant: ledger version + behaviour flags; `push` updates origin/main. Returns the full sha. */
  const commit = (label, { ledger = 43, behavior = {}, push = true } = {}) => {
    put(root, 'src/adapters/core/sqlite-ledger/internal/schema.ts', `export const CURRENT_LEDGER_VERSION = ${ledger};\n`);
    put(root, 'src/behavior.json', JSON.stringify({ label, ...behavior }));
    git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', label);
    if (push) git(root, 'push', '--quiet', 'origin', 'main');
    return git(root, 'rev-parse', 'HEAD');
  };
  return { commit, git: (...args) => git(root, ...args) };
}
