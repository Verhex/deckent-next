#!/usr/bin/env node
// dev-release (DEV-U2-0, owner U2 option C 2026-09-30): side-by-side versions of the developer live installation. Host tooling only, never
// part of the product or its packages; the product slices U2-1…U2-6 replace it (deletion criterion: product `update rollback` passes the same
// acceptance). Layout under $DECKENT_NEXT_INSTALL_ROOT (default ~/.local/share/deckent-next-dev):
//   versions/<commit12>-<tree12>/  the unpacked build-dist package of one reviewed commit + release.json + manifest.json (per-file sha256)
//   current -> versions/<id>       relative symlink, replaced atomically with rename(2); next-entry.mjs runs realpath(current)
//   previous                       the id `rollback` returns to (`checkout` = no current: the checkout's dist, today's behaviour)
//   switches.jsonl                 one record per switch/rollback;  switches/<ts>/ state-file snapshots;  logs/ service logs
// Commands (JSON on stdout; exit 0 ok, 1 refused/failed, 2 usage, 3 confirmation required):
//   stage <commit> [--allow-local] [--preview] [--bwrap <dir>] [--remote-ref origin/main] [--source <repo>] [--waive-smoke <check,…>] [--keep-build]
//         [--allow-same-version]
//       clone --local --no-hardlinks (nothing is written into the live .git; Jev 2b6f9f73) → npm ci → build → build-dist --pack --bwrap →
//       smoke:dist on the tarball and on the unpacked tree → versions/<id>. Refuses unknown commits, a dirty symbolic ref, unpushed commits
//       (unless --allow-local/--preview), a dirty build and a package without the bundled bubblewrap (other publication blockers are
//       recorded, not refused); a failed smoke installs nothing. Owner rule 2026-10-03: every live release bumps the package version, so a
//       commit whose package.json version equals the current version's is refused (DEV_RELEASE_SAME_VERSION) unless --allow-same-version
//       (recorded as sameVersionWaived; packageVersion is null when package.json or its version is missing: no check).
//   switch <id> [--allow-local]    governed shutdown through the running service's own CLI (describe → shutdown --command-id), atomic pointer,
//       start through next-entry, describe must report the release's build; otherwise the pointer goes back (only while the ledger still fits
//       the old code; a migrated ledger stops with DEV_RELEASE_OPERATOR_REQUIRED instead of starting code that cannot open it).
//   rollback [--to <id>|checkout] [--restore-ledger [--confirm <token>]] [--restore-state]
//       pointer back; when the ledger moved past what the target opens, only with --restore-ledger: first call stops the service and prints the
//       loss report and a token bound to the stopped ledger (Jev 39e921e3); the --confirm call recomputes it under the ledger lock (an existing
//       <ledger>-lock only, never created: a created file would fail the product's own lock checks) and restores the pre-upgrade backup.
//   start | status | prune         start the current version's service; show state; list versions beyond the last 3 not in use (deletion is
//       the owner's: the tool prints the command).
// Common: [--node <node>] (default: this Node) [--launcher <project>/.agents/refactor/next-entry.mjs] (the project = launcher's ../..).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KEEP = 3;
const CLI_ENTRY = 'dist/composition/core/cli/internal/entry.js';
const ID = /^[0-9a-f]{12}-[0-9a-f]{12}$/u;

class ReleaseError extends Error { constructor(code, detail = {}, exitCode = 1) { super(code); this.code = code; this.detail = detail; this.exitCode = exitCode; } }
const fail = (code, detail, exitCode) => { throw new ReleaseError(code, detail, exitCode); };
const sha256 = data => createHash('sha256').update(data).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

export function layout({ env = process.env, home = homedir(), launcher = join(here, 'next-entry.mjs') } = {}) {
  const installRoot = resolve(env.DECKENT_NEXT_INSTALL_ROOT || join(home, '.local/share/deckent-next-dev'));
  const project = resolve(dirname(launcher), '../..');
  if (inside(installRoot, project)) fail('DEV_RELEASE_INSTALL_ROOT_INSIDE_PROJECT', { installRoot, project });
  return { installRoot, project, launcher, versions: join(installRoot, 'versions'), current: join(installRoot, 'current'),
    globalHome: join(home, '.local/state/deckent-next-dev') };
}

/** Product data paths from the project's own config (layout.root / layout.resources), as the product resolves them. */
export function dataPaths(project) {
  let config = {}; try { config = readJson(join(project, '.deckent/config.json')); } catch { /* defaults */ }
  const root = config.layout?.root ?? join(project, '.deckent'), resources = config.layout?.resources ?? {};
  const ledger = join(root, ...(resources.ledger ?? 'state/ledger.db').split('/'));
  return { config: join(project, '.deckent/config.json'), root, ledger, lock: `${ledger}-lock`,
    backups: join(root, ...(resources.ledgerBackups ?? 'state/backups').split('/')),
    policy: join(root, ...(resources.policy ?? 'policy.json').split('/')), bindings: join(root, ...(resources.bindings ?? 'bindings.json').split('/')) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60_000, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}
function must(code, command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) fail(code, { command: [command, ...args].join(' '), status: result.status, stderr: `${result.stderr}${result.error?.message ?? ''}`.slice(-2000) });
  return result.stdout;
}
const git = (repo, args, code = 'DEV_RELEASE_GIT') => must(code, 'git', ['--no-optional-locks', '-C', repo, ...args]).trim();
const lastJson = text => { const at = text.search(/^\{/mu); if (at < 0) fail('DEV_RELEASE_OUTPUT', { tail: text.slice(-500) }); return JSON.parse(text.slice(at)); };

/** Exclusive flock on an already open descriptor: util-linux flock(1) locks the inherited open file description, which stays locked in
 * this process after the child exits (the product's native lock uses the same flock(2) LOCK_EX|LOCK_NB). */
function flockFd(fd) {
  const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail('DEV_RELEASE_FLOCK_UNAVAILABLE', { status: result.status, stderr: String(result.stderr ?? '') });
}
function installLock(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const fd = openSync(join(root, '.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  if (!flockFd(fd)) { closeSync(fd); fail('DEV_RELEASE_BUSY', { lock: join(root, '.lock') }); }
  return () => closeSync(fd);
}
/** The ledger custody for a restore: only an existing, private, single-link lock file (the product's own checks); never created here. */
export function ledgerLock(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); }
  catch (error) { fail(error.code === 'ENOENT' ? 'DEV_RELEASE_LEDGER_LOCK_MISSING' : 'DEV_RELEASE_LEDGER_LOCK_UNSAFE', { lock: path, error: error.code }); }
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) {
    closeSync(fd); fail('DEV_RELEASE_LEDGER_LOCK_UNSAFE', { lock: path, mode: (opened.mode & 0o777).toString(8), nlink: opened.nlink });
  }
  if (!flockFd(fd)) { closeSync(fd); fail('DEV_RELEASE_LEDGER_BUSY', { lock: path }); }
  const linked = lstatSync(path);
  if (!linked.isFile() || linked.ino !== opened.ino || linked.dev !== opened.dev) { closeSync(fd); fail('DEV_RELEASE_LEDGER_LOCK_UNSAFE', { lock: path, swapped: true }); }
  return () => closeSync(fd);
}
/** Whether some process holds the ledger custody right now (a running service), without keeping it. */
function ledgerHeld(path) {
  let fd; try { fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW); } catch { return false; }
  try { return !flockFd(fd); } finally { closeSync(fd); }
}

// --- SQLite (node:sqlite, read-only; `immutable` when no -wal exists so nothing is created next to a quiescent file) --------------------
const sqlite = () => createRequire(import.meta.url)('node:sqlite');
function openRead(path) {
  const { DatabaseSync } = sqlite();
  const url = pathToFileURL(path); if (!existsSync(`${path}-wal`)) url.search = 'immutable=1';
  return new DatabaseSync(url, { readOnly: true });
}
export function ledgerVersion(path) {
  if (!existsSync(path)) return null;
  const db = openRead(path); try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
}
function tableCounts(path) {
  const db = openRead(path);
  try {
    const out = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      out[name] = db.prepare(`SELECT count(*) AS c FROM "${name.replaceAll('"', '""')}"`).get().c;
    return out;
  } finally { db.close(); }
}
/** Rows the restore discards: per table, current rows minus backup rows (tables the backup lacks count whole). */
export function lossReport(ledger, backup) {
  const now = tableCounts(ledger), then = tableCounts(backup), rows = {};
  for (const [name, count] of Object.entries(now)) { const lost = count - (then[name] ?? 0); if (lost !== 0) rows[name] = lost; }
  const at = /ledger-v\d+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u.exec(basename(backup));
  const backupAt = at ? `${at[1]}T${at[2]}:${at[3]}:${at[4]}.${at[5]}Z` : statSync(backup).mtime.toISOString();
  return { backup, backupAt, until: new Date().toISOString(), ledgerVersion: ledgerVersion(ledger), backupVersion: ledgerVersion(backup),
    rowsWrittenAfterBackup: rows, rowsTotal: Object.values(rows).reduce((sum, value) => sum + Math.max(0, value), 0) };
}
/** The confirmation token binds the exact stopped ledger (content counts, file identity), the backup bytes and the pointer move. */
function restoreToken(paths, backup, from, to) {
  const files = ['', '-wal'].map(suffix => { try { const s = statSync(paths.ledger + suffix); return [suffix, s.ino, s.size, s.mtimeMs]; } catch { return [suffix, null]; } });
  return sha256(JSON.stringify({ from, to, backup, backupSha256: sha256(readFileSync(backup)), files, counts: tableCounts(paths.ledger) })).slice(0, 16);
}

// --- versions and pointer -------------------------------------------------------------------------------------------------------------
function readRelease(L, id) {
  if (!ID.test(id ?? '')) fail('DEV_RELEASE_ID_INVALID', { id }, 2);
  const dir = join(L.versions, id);
  let release; try { release = readJson(join(dir, 'release.json')); } catch { fail('DEV_RELEASE_UNKNOWN_VERSION', { id }); }
  if (release.versionId !== id) fail('DEV_RELEASE_UNKNOWN_VERSION', { id, versionId: release.versionId });
  return { ...release, dir };
}
function currentId(L) {
  try { lstatSync(L.current); } catch { return null; }
  const target = readlinkSync(L.current), id = basename(target);
  if (target !== `versions/${id}` || !ID.test(id)) fail('DEV_RELEASE_CURRENT_INVALID', { target });
  return id;
}
/** Atomic pointer move: a new relative symlink renamed over `current` (rename(2) replaces it with no missing instant). */
function setCurrent(L, id) {
  if (id === 'checkout') { try { unlinkSync(L.current); } catch (error) { if (error.code !== 'ENOENT') throw error; } return; }
  const tmp = join(L.installRoot, `current.tmp-${process.pid}`);
  try { unlinkSync(tmp); } catch { /* absent */ }
  symlinkSync(`versions/${id}`, tmp); renameSync(tmp, L.current);
  const dir = openSync(L.installRoot, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
const previousId = L => { try { return readFileSync(join(L.installRoot, 'previous'), 'utf8').trim() || null; } catch { return null; } };
const writePrevious = (L, id) => writeFileSync(join(L.installRoot, 'previous'), `${id}\n`, { mode: 0o600 });
const record = (L, entry) => writeFileSync(join(L.installRoot, 'switches.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: 'a', mode: 0o600 });
function lastSwitchTo(L, id) {
  try { return readFileSync(join(L.installRoot, 'switches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).reverse().find(entry => entry.to === id && entry.ok) ?? null; }
  catch { return null; }
}
const codeDir = (L, id) => id === 'checkout' || id === null ? L.project : join(L.versions, id);
/** The newest ledger version the code in `dir` opens (its compiled CURRENT_LEDGER_VERSION). */
function codeLedgerVersion(dir) {
  try { return Number(/CURRENT_LEDGER_VERSION = (\d+)/u.exec(readFileSync(join(dir, 'dist/adapters/core/sqlite-ledger/internal/schema.js'), 'utf8'))[1]); }
  catch { fail('DEV_RELEASE_METADATA_MISSING', { dir, field: 'CURRENT_LEDGER_VERSION' }); }
}
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
}
const manifestOf = dir => Object.fromEntries(walk(dir).map(path => relative(dir, path)).filter(path => path !== 'release.json' && path !== 'manifest.json').sort()
  .map(path => [path, `${sha256(readFileSync(join(dir, path)))}:${(lstatSync(join(dir, path)).mode & 0o777).toString(8)}`]));
function verifyManifest(release) {
  const text = readFileSync(join(release.dir, 'manifest.json'), 'utf8');
  if (sha256(text) !== release.manifestSha256) fail('DEV_RELEASE_MANIFEST_MISMATCH', { id: release.versionId, file: 'manifest.json' });
  const expected = JSON.parse(text), actual = manifestOf(release.dir);
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(path => expected[path] !== actual[path]);
  if (changed.length) fail('DEV_RELEASE_MANIFEST_MISMATCH', { id: release.versionId, changed: changed.slice(0, 20) });
}
/** Processes whose command line runs code from a version directory (next-entry passes the real path; MCP servers and terminals too). */
function versionUsers(L) {
  const out = []; let real; try { real = realpathSync(L.versions); } catch { return out; }
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
    let argv; try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    for (const arg of argv) if (arg.startsWith(real + sep)) { out.push({ pid: Number(pid), id: arg.slice(real.length + 1).split(sep)[0], arg }); break; }
  }
  return out;
}
function checkoutUsers(L) {
  const out = [], dist = join(L.project, 'dist') + sep;
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
    let argv; try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (argv.some(arg => arg.startsWith(dist))) out.push({ pid: Number(pid), argv: argv.filter(Boolean).slice(0, 4).join(' ') });
  }
  return out;
}

// --- the running service, always through the product's own CLI ------------------------------------------------------------------------
function productEnv(L) {
  const env = { ...process.env, DECKENT_GLOBAL_HOME: L.globalHome }; delete env.DECKENT_HOME; return env;
}
function describe(L, cli, node) {
  const result = run(node, [cli, 'runtime', 'describe', '--json'], { cwd: L.project, env: productEnv(L), timeout: 30_000 });
  if (result.status !== 0) return { descriptor: null, stderr: result.stderr.trim().slice(-400) };
  try { return { descriptor: lastJson(result.stdout) }; } catch { return { descriptor: null, stderr: result.stdout.slice(-400) }; }
}
function cliOfProcess(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find(arg => arg.endsWith(`/${CLI_ENTRY}`)) ?? null; } catch { return null; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Governed stop through the service's own CLI: describe → shutdown with a fresh command id → absence (describe fails, process gone). */
async function stopService(L, fallbackCli, opts, purpose) {
  const found = describe(L, fallbackCli, opts.node);
  if (!found.descriptor) {
    if (ledgerHeld(dataPaths(L.project).lock)) fail('DEV_RELEASE_SERVICE_UNREACHABLE', { stderr: found.stderr });
    return { state: 'absent' };
  }
  const d = found.descriptor;
  if (!d.shutdownAvailable) fail('DEV_RELEASE_SHUTDOWN_UNAVAILABLE', { instanceId: d.instanceId });
  const cli = (d.processId && cliOfProcess(d.processId)) || fallbackCli;
  const commandId = `dev-release-${purpose}-${stamp()}`;
  const shutdown = run(opts.node, [cli, 'runtime', 'shutdown', '--service', d.identity.serviceId, '--instance', d.instanceId,
    '--command-id', commandId, '--reason', `dev-release ${purpose}`, '--json'], { cwd: L.project, env: productEnv(L), timeout: 60_000 });
  if (shutdown.status !== 0) fail('DEV_RELEASE_SHUTDOWN_REFUSED', { commandId, stderr: shutdown.stderr.trim().slice(-800) });
  const started = Date.now();
  while (Date.now() - started < opts.stopTimeoutMs) {
    if (!(d.processId && alive(d.processId)) && !describe(L, cli, opts.node).descriptor) {
      return { state: 'stopped', instanceId: d.instanceId, processId: d.processId, build: d.build ?? null, cli, commandId, stopMs: Date.now() - started };
    }
    await sleep(150);
  }
  fail('DEV_RELEASE_STOP_TIMEOUT', { commandId, processId: d.processId });
}

/** Start through the launcher (next-entry → realpath(current)), then require describe to report `build`. */
async function startService(L, expect, opts) {
  mkdirSync(join(L.installRoot, 'logs'), { recursive: true, mode: 0o700 });
  const log = join(L.installRoot, 'logs', `serve-${stamp()}-${expect.label}.log`);
  const fd = openSync(log, 'a', 0o600);
  // Sol U2-R1: a launcher that cannot be created (ENOENT, EACCES, EAGAIN…) is reported by Node as an asynchronous 'error' event (or, for
  // invalid arguments, a synchronous throw). It is listened for before anything else and becomes a failed result with no pid, so the
  // callers' discard / ledger-compatibility / pointer-rollback / record path runs instead of an unhandled event killing the tool.
  let child = null, launchError = null, exited = null;
  try {
    child = (opts.spawn ?? spawn)(opts.node, [L.launcher, 'cli', 'runtime', 'serve', '--json'], { cwd: L.project, env: { ...process.env, DECKENT_NEXT_INSTALL_ROOT: L.installRoot },
      detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', error => { launchError ??= error; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.unref?.();
  } catch (error) { launchError = error; } finally { closeSync(fd); }
  const cli = join(codeDir(L, expect.id), CLI_ENTRY), started = Date.now();
  const events = () => readFileSync(log, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const launchFailed = () => ({ ok: false, log, launchError: launchError.code ?? 'SPAWN_FAILED', launcherPid: null, startMs: Date.now() - started, ledgerUpgrade: null,
    tail: `launcher not created: ${launchError.message}` });
  while (Date.now() - started < opts.startTimeoutMs) {
    if (launchError) return launchFailed();
    await sleep(150);
    if (launchError) return launchFailed();
    const { descriptor } = describe(L, cli, opts.node);
    const upgraded = events().find(event => event.event === 'ledger-upgraded') ?? null;
    if (descriptor) {
      const ok = descriptor.build?.sourceCommit === expect.sourceCommit && descriptor.build?.sourceTreeSha256 === expect.sourceTreeSha256;
      return { ok, log, launcherPid: child?.pid ?? null, descriptor, startMs: Date.now() - started, ledgerUpgrade: upgraded };
    }
    if (exited) return { ok: false, log, exited, startMs: Date.now() - started, ledgerUpgrade: upgraded, tail: readFileSync(log, 'utf8').slice(-800) };
  }
  return { ok: false, log, timeout: true, launcherPid: child?.pid ?? null, ledgerUpgrade: null, tail: readFileSync(log, 'utf8').slice(-800) };
}
/** Stop a started service that failed verification: governed when it answers, else the launcher's process group. */
async function discard(L, started, opts, id) {
  if (started.descriptor) { try { await stopService(L, join(codeDir(L, id), CLI_ENTRY), opts, 'discard'); return; } catch { /* fall through */ } }
  if (started.launcherPid && alive(started.launcherPid)) {
    try { process.kill(-started.launcherPid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 100 && alive(started.launcherPid); i++) await sleep(100);
    try { process.kill(-started.launcherPid, 'SIGKILL'); } catch { /* gone */ }
  }
}
const expectOf = (L, id) => {
  if (id === 'checkout') { const identity = readJson(join(L.project, 'dist/build-identity.json')); return { id, label: 'checkout', ...identity }; }
  const release = readRelease(L, id); return { id, label: id, sourceCommit: release.sourceCommit, sourceTreeSha256: release.sourceTreeSha256 };
};
function snapshotState(L, paths) {
  const dir = join(L.installRoot, 'switches', stamp()); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = {};
  for (const [name, path] of Object.entries({ config: paths.config, policy: paths.policy, bindings: paths.bindings })) {
    if (!existsSync(path)) { manifest[name] = null; continue; }
    copyFileSync(path, join(dir, name)); chmodSync(join(dir, name), 0o600);
    manifest[name] = { path, sha256: sha256(readFileSync(path)) };
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return dir;
}
function changedState(snapshot) {
  if (!snapshot || !existsSync(join(snapshot, 'manifest.json'))) return [];
  return Object.entries(readJson(join(snapshot, 'manifest.json'))).filter(([, entry]) => entry)
    .filter(([, entry]) => !existsSync(entry.path) || sha256(readFileSync(entry.path)) !== entry.sha256).map(([name, entry]) => ({ name, path: entry.path, snapshot: join(snapshot, name) }));
}

// --- commands ---------------------------------------------------------------------------------------------------------------------
function packageVersion(source, sha) {
  try { const v = JSON.parse(run('git', ['--no-optional-locks', '-C', source, 'show', `${sha}:package.json`]).stdout).version; return typeof v === 'string' && v ? v : null; } catch { return null; }
}
export async function stage(L, ref, opts) {
  const source = opts.source ? resolve(opts.source) : L.project;
  let sha; try { sha = git(source, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 'DEV_RELEASE_UNKNOWN_COMMIT'); } catch { fail('DEV_RELEASE_UNKNOWN_COMMIT', { ref }); }
  if (!/^[0-9a-f]{7,64}$/u.test(ref) && git(source, ['status', '--porcelain', '--untracked-files=no'])) fail('DEV_RELEASE_SOURCE_DIRTY', { ref, hint: 'the build uses the commit, not the working tree: pass the commit sha' });
  const pushed = run('git', ['--no-optional-locks', '-C', source, 'merge-base', '--is-ancestor', sha, opts.remoteRef]).status === 0;
  if (!pushed && !opts.allowLocal && !opts.preview) fail('DEV_RELEASE_UNPUSHED', { sha, remoteRef: opts.remoteRef });
  const bwrap = opts.bwrap ?? (() => { const packs = join(source, '.pack/bwrap');
    return existsSync(packs) ? readdirSync(packs).map(name => join(packs, name)).filter(dir => existsSync(join(dir, 'out'))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined; })();
  if (!bwrap || !existsSync(bwrap)) fail('DEV_RELEASE_BWRAP_MISSING', { hint: 'pass --bwrap <build-bwrap output>' });
  const staged = existsSync(L.versions) ? readdirSync(L.versions).find(name => ID.test(name) && name.startsWith(`${sha.slice(0, 12)}-`)) : undefined;
  if (staged) return { ok: true, alreadyStaged: true, id: staged, dir: join(L.versions, staged) };
  const packageVer = packageVersion(source, sha), live = currentId(L);
  const liveVer = live ? packageVersion(source, readRelease(L, live).sourceCommit) : null, same = packageVer !== null && packageVer === liveVer;
  if (same && !opts.allowSameVersion) fail('DEV_RELEASE_SAME_VERSION', { sha, version: packageVer, currentId: live, hint: 'bump package.json (owner rule 2026-10-03) or pass --allow-same-version' });
  const unlock = installLock(L.installRoot), build = join(L.installRoot, 'build', `${sha.slice(0, 12)}-${process.pid}`), timings = {};
  const step = (name, fn) => { const at = Date.now(); try { return fn(); } finally { timings[name] = Date.now() - at; } };
  try {
    mkdirSync(L.versions, { recursive: true, mode: 0o700 });
    step('clone', () => { must('DEV_RELEASE_CLONE', 'git', ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', source, build]);
      git(build, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha]); });
    const npmCli = join(dirname(opts.node), '../lib/node_modules/npm/bin/npm-cli.js'), npm = existsSync(npmCli) ? [opts.node, npmCli] : ['npm'];
    const env = { ...process.env, DECKENT_BWRAP_BUILD: bwrap, PATH: `${dirname(opts.node)}:${process.env.PATH}` };
    step('npmCi', () => must('DEV_RELEASE_NPM_CI', npm[0], [...npm.slice(1), 'ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: build, env }));
    step('build', () => must('DEV_RELEASE_BUILD', opts.node, ['scripts/build.mjs'], { cwd: build, env }));
    const identity = readJson(join(build, 'dist/build-identity.json'));
    if (identity.sourceCommit !== sha || identity.sourceDirty !== false) fail('DEV_RELEASE_BUILD_DIRTY', { sha, sourceCommit: identity.sourceCommit, sourceDirty: identity.sourceDirty });
    const packed = step('buildDist', () => lastJson(must('DEV_RELEASE_BUILD_DIST', opts.node, ['scripts/build-dist.mjs', '--out', join(build, '.pack/release'), '--pack', '--bwrap', bwrap], { cwd: build, env })));
    // The bundled bubblewrap is a runtime requirement (without it the sandbox falls back to Landlock, live 2026-09-29): refused. The other
    // publication blockers (third-party licence texts, declaration leaks; PLAN DEPS-DIST, owner-open) gate a public release, not the
    // developer's own installation: recorded in release.json and reported, not refused.
    if (!packed.bubblewrap?.shipped || !packed.packed?.tarball) fail('DEV_RELEASE_UNPUBLISHABLE', { blockers: packed.publishable?.blockers ?? [], bubblewrap: packed.bubblewrap ?? null });
    const id = `${sha.slice(0, 12)}-${identity.sourceTreeSha256.slice(0, 12)}`, dir = join(L.versions, id);
    if (existsSync(dir)) return { ok: true, alreadyStaged: true, id, dir };
    const smokeTarball = step('smokeTarball', () => run(opts.node, ['scripts/pack-smoke.mjs', packed.packed.tarball, '--node', opts.node], { cwd: build, env }));
    const tarballReport = (() => { try { return lastJson(smokeTarball.stdout); } catch { return null; } })();
    // A failed smoke check refuses the stage unless the operator waived exactly that check (--waive-smoke a,b), recorded in release.json.
    const unwaived = report => report ? Object.entries(report.checks ?? {}).filter(([name, c]) => !c.ok && !opts.waiveSmoke.includes(name)).map(([name]) => name) : ['report'];
    if (unwaived(tarballReport).length) fail('DEV_RELEASE_SMOKE_FAILED', { artifact: 'tarball', failed: unwaived(tarballReport), stderr: smokeTarball.stderr.slice(-800) });
    const partial = `${dir}.partial-${process.pid}`; mkdirSync(partial, { mode: 0o700 });
    try {
      must('DEV_RELEASE_UNPACK', 'tar', ['-xzf', packed.packed.tarball, '-C', partial, '--strip-components=1', '--no-same-owner']);
      const unpacked = readJson(join(partial, 'dist/build-identity.json'));
      if (unpacked.sourceCommit !== sha || unpacked.sourceTreeSha256 !== identity.sourceTreeSha256) fail('DEV_RELEASE_BUILD_DIRTY', { unpacked });
      const version = must('DEV_RELEASE_SMOKE_FAILED', opts.node, [join(partial, CLI_ENTRY), '--version'], { cwd: build }).trim();
      const smokeRoot = step('smokeRoot', () => run(opts.node, ['scripts/pack-smoke.mjs', '--root', partial, '--node', opts.node], { cwd: build, env }));
      const rootReport = (() => { try { return lastJson(smokeRoot.stdout); } catch { return null; } })();
      if (unwaived(rootReport).length) fail('DEV_RELEASE_SMOKE_FAILED', { artifact: 'unpacked', failed: unwaived(rootReport) });
      const manifest = `${JSON.stringify(manifestOf(partial), null, 1)}\n`;
      writeFileSync(join(partial, 'manifest.json'), manifest, { mode: 0o600 });
      let protocol = null;
      try { protocol = /RUNTIME_SERVICE_SCHEMA_VERSION = (\d+)/u.exec(readFileSync(join(partial, 'dist/engine/core/runtime/internal/service-protocol.js'), 'utf8'))?.[1] ?? null; } catch { /* recorded as null */ }
      const release = { schemaVersion: 1, versionId: id, sequence: (stagedOrder(L)[0]?.sequence ?? 0) + 1, sourceCommit: sha, sourceTreeSha256: identity.sourceTreeSha256, identity, version, packageVersion: packageVer, sameVersionWaived: same,
        publishable: { ok: Boolean(packed.publishable?.ok), blockers: packed.publishable?.blockers ?? [] }, pushed, remoteRef: opts.remoteRef, local: !pushed && !opts.preview, preview: Boolean(opts.preview), node: spawnSync(opts.node, ['--version'], { encoding: 'utf8' }).stdout.trim(),
        ledgerVersion: codeLedgerVersion(partial), protocolVersion: protocol === null ? null : Number(protocol),
        tarball: { name: basename(packed.packed.tarball), sha256: packed.packed.sha256, size: packed.packed.size },
        smoke: { tarball: Object.fromEntries(Object.entries(tarballReport.checks).map(([n, c]) => [n, c.ok])), unpacked: Object.fromEntries(Object.entries(rootReport.checks).map(([n, c]) => [n, c.ok])),
          waived: opts.waiveSmoke.filter(name => [tarballReport, rootReport].some(report => report.checks?.[name] && !report.checks[name].ok)) },
        bwrap, manifestSha256: sha256(manifest), stagedAt: new Date().toISOString(), timingsMs: timings };
      const fd = openSync(join(partial, 'release.json'), 'w', 0o600); writeSync(fd, `${JSON.stringify(release, null, 2)}\n`); fsyncSync(fd); closeSync(fd);
      renameSync(partial, dir);
      const parent = openSync(L.versions, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
      return { ok: true, id, dir, release, pruneCandidates: pruneCandidates(L).map(entry => entry.id) };
    } finally { rmSync(partial, { recursive: true, force: true }); }
  } finally {
    if (!opts.keepBuild) rmSync(build, { recursive: true, force: true });
    unlock();
  }
}

export async function switchTo(L, id, opts) {
  const release = readRelease(L, id);
  if (release.preview) fail('DEV_RELEASE_PREVIEW_NOT_SWITCHABLE', { id });
  if (release.local && !opts.allowLocal) fail('DEV_RELEASE_UNREVIEWED', { id, hint: 'stage a pushed, reviewed commit' });
  const smokeOk = checks => Object.entries(checks ?? {}).every(([name, ok]) => ok || (release.smoke?.waived ?? []).includes(name));
  if (!release.smoke || !smokeOk(release.smoke.tarball) || !smokeOk(release.smoke.unpacked)) fail('DEV_RELEASE_SMOKE_FAILED', { id });
  verifyManifest(release);
  const unlock = installLock(L.installRoot);
  try {
    const from = currentId(L) ?? 'checkout';
    if (from === id) fail('DEV_RELEASE_ALREADY_CURRENT', { id });
    const paths = dataPaths(L.project), fromCode = codeDir(L, from);
    const stopped = await stopService(L, join(fromCode, CLI_ENTRY), opts, `switch-${id}`);
    const ledgerBefore = ledgerVersion(paths.ledger), snapshot = snapshotState(L, paths);
    setCurrent(L, id);
    const started = await startService(L, expectOf(L, id), opts);
    const ledgerAfter = ledgerVersion(paths.ledger);
    const base = { action: 'switch', from, to: id, fromBuild: stopped.build ?? null, shutdownCommandId: stopped.commandId ?? null, stoppedVia: stopped.cli ?? null, stopMs: stopped.stopMs ?? null,
      startMs: started.startMs, ledgerBefore, ledgerAfter, ledgerBackup: started.ledgerUpgrade?.backupPath ?? null, snapshot, log: started.log,
      launchError: started.launchError ?? null };
    if (started.ok) {
      writePrevious(L, from); record(L, { ...base, ok: true, instanceId: started.descriptor.instanceId });
      return { ok: true, ...base, service: started.descriptor };
    }
    await discard(L, started, opts, id);
    const ledgerNow = ledgerVersion(paths.ledger), fits = ledgerNow === null || ledgerNow <= codeLedgerVersion(fromCode);
    if (!fits) {
      record(L, { ...base, ok: false, state: 'operator-required', ledgerNow });
      fail('DEV_RELEASE_OPERATOR_REQUIRED', { ...base, ledgerNow, service: 'stopped', hint: `ledger v${ledgerNow} is newer than ${from} opens: node .agents/refactor/dev-release.mjs rollback --to ${from} --restore-ledger` });
    }
    setCurrent(L, from);
    const restored = stopped.state === 'stopped' ? await startService(L, expectOf(L, from), opts) : null;
    record(L, { ...base, ok: false, state: 'rolled-back', restarted: restored?.ok ?? null });
    fail('DEV_RELEASE_SWITCH_FAILED', { ...base, reason: started.launchError ? `launcher failed: ${started.launchError}` : started.exited ? 'service exited' : started.timeout ? 'no answer' : 'build mismatch',
      reported: started.descriptor?.build ?? null, tail: started.tail, pointer: from, previousService: restored ? { ok: restored.ok, build: restored.descriptor?.build ?? null } : 'was not running' });
  } finally { unlock(); }
}

export async function rollback(L, opts) {
  const unlock = installLock(L.installRoot);
  try {
    const from = currentId(L);
    if (!from) fail('DEV_RELEASE_NO_CURRENT', {});
    const to = opts.to ?? previousId(L);
    if (!to) fail('DEV_RELEASE_NO_PREVIOUS', {});
    if (to !== 'checkout') readRelease(L, to);
    if (to === from) fail('DEV_RELEASE_ALREADY_CURRENT', { id: to });
    const paths = dataPaths(L.project), supports = codeLedgerVersion(codeDir(L, to)), ledgerNow = ledgerVersion(paths.ledger);
    const restore = ledgerNow !== null && ledgerNow > supports;
    if (restore && !opts.restoreLedger) fail('DEV_RELEASE_LEDGER_AHEAD', { ledger: ledgerNow, targetOpens: supports, to, hint: 'rollback --restore-ledger (discards ledger writes made after the pre-upgrade backup)' });
    let backup = null;
    if (restore) {
      const recorded = lastSwitchTo(L, from)?.ledgerBackup;
      const candidates = recorded ? [recorded] : (existsSync(paths.backups) ? readdirSync(paths.backups).filter(name => /^ledger-v\d+-\d{4}-.*Z\.db$/u.test(name)).sort().reverse().map(name => join(paths.backups, name)) : []);
      backup = candidates.find(path => existsSync(path) && (ledgerVersion(path) ?? Infinity) <= supports) ?? null;
      if (!backup) fail('DEV_RELEASE_BACKUP_MISSING', { targetOpens: supports, recorded: recorded ?? null, backups: paths.backups });
    }
    const stopped = await stopService(L, join(codeDir(L, from), CLI_ENTRY), opts, `rollback-${to}`);
    const snapshot = lastSwitchTo(L, from)?.snapshot ?? null, stateChanges = changedState(snapshot);
    let restored = null;
    if (restore) {
      const token = restoreToken(paths, backup, from, to);
      if (!opts.confirm) {
        return { ok: false, code: 'DEV_RELEASE_CONFIRM_REQUIRED', exitCode: 3, service: stopped.state === 'stopped' ? 'stopped by this call' : 'was not running', pointer: from,
          loss: lossReport(paths.ledger, backup), stateChanges, token,
          next: { restore: `node .agents/refactor/dev-release.mjs rollback --to ${to} --restore-ledger --confirm ${token}`, abort: 'node .agents/refactor/dev-release.mjs start' } };
      }
      const release = ledgerLock(paths.lock);
      try {
        const now = restoreToken(paths, backup, from, to);
        if (now !== opts.confirm) fail('DEV_RELEASE_CONFIRM_STALE', { hint: 'the ledger or backup changed since the report: run without --confirm again', loss: lossReport(paths.ledger, backup) });
        const loss = lossReport(paths.ledger, backup), at = stamp(), kept = [];
        for (const suffix of ['', '-wal', '-shm']) {
          if (!existsSync(paths.ledger + suffix)) continue;
          const target = join(paths.backups, `ledger-v${ledgerNow}-rolledback-${at}.db${suffix}`); renameSync(paths.ledger + suffix, target); kept.push(target);
        }
        const tmp = `${paths.ledger}.restore-${process.pid}`;
        copyFileSync(backup, tmp, constants.COPYFILE_EXCL); chmodSync(tmp, 0o600);
        const fd = openSync(tmp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, paths.ledger);
        const dir = openSync(dirname(paths.ledger), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
        restored = { backup, kept, loss, ledger: ledgerVersion(paths.ledger) };
      } finally { release(); }
    }
    const stateRestored = [];
    if (opts.restoreState) for (const change of stateChanges) {
      if (existsSync(change.path)) renameSync(change.path, `${change.path}.rolledback-${stamp()}`);
      copyFileSync(change.snapshot, change.path); chmodSync(change.path, 0o600); stateRestored.push(change.path);
    }
    setCurrent(L, to); writePrevious(L, from);
    const started = await startService(L, expectOf(L, to), opts);
    const entry = { action: 'rollback', from, to, ledgerBefore: ledgerNow, ledgerAfter: ledgerVersion(paths.ledger), restored, stateChanges, stateRestored, launchError: started.launchError ?? null,
      shutdownCommandId: stopped.commandId ?? null, log: started.log, ok: started.ok };
    record(L, entry);
    if (!started.ok) fail('DEV_RELEASE_START_FAILED', { ...entry, tail: started.tail, reported: started.descriptor?.build ?? null });
    return { ok: true, ...entry, service: started.descriptor };
  } finally { unlock(); }
}

export async function start(L, opts) {
  const unlock = installLock(L.installRoot);
  try {
    const id = currentId(L) ?? 'checkout', cli = join(codeDir(L, id), CLI_ENTRY);
    const running = describe(L, cli, opts.node).descriptor;
    if (running) return { ok: true, already: true, service: running };
    if (ledgerHeld(dataPaths(L.project).lock)) fail('DEV_RELEASE_SERVICE_UNREACHABLE', {});
    const started = await startService(L, expectOf(L, id), opts);
    if (!started.ok) { await discard(L, started, opts, id); fail('DEV_RELEASE_START_FAILED', { id, launchError: started.launchError ?? null, tail: started.tail, reported: started.descriptor?.build ?? null }); }
    return { ok: true, id, service: started.descriptor, log: started.log };
  } finally { unlock(); }
}

/** Staged versions, newest first by the install's own staging sequence (wall-clock time can jump; WSL resyncs it). */
function stagedOrder(L) {
  if (!existsSync(L.versions)) return [];
  return readdirSync(L.versions).filter(name => ID.test(name)).map(id => { try { return { id, sequence: readJson(join(L.versions, id, 'release.json')).sequence ?? 0 }; } catch { return { id, sequence: 0 }; } })
    .sort((a, b) => b.sequence - a.sequence);
}
function pruneCandidates(L) {
  if (!existsSync(L.versions)) return [];
  const keep = new Set([currentId(L), previousId(L)]), used = new Set(versionUsers(L).map(entry => entry.id));
  const staged = stagedOrder(L);
  return staged.slice(KEEP).filter(entry => !keep.has(entry.id) && !used.has(entry.id));
}
export function status(L, opts) {
  const id = currentId(L), paths = dataPaths(L.project);
  const versions = existsSync(L.versions) ? readdirSync(L.versions).filter(name => ID.test(name)).map(name => { try { const r = readRelease(L, name);
    return { id: name, sourceCommit: r.sourceCommit, ledgerVersion: r.ledgerVersion, protocolVersion: r.protocolVersion, preview: r.preview, local: r.local, stagedAt: r.stagedAt }; }
  catch { return { id: name, invalid: true }; } }) : [];
  const { descriptor } = describe(L, join(codeDir(L, id ?? 'checkout'), CLI_ENTRY), opts.node);
  const runsFrom = descriptor?.processId ? cliOfProcess(descriptor.processId) : null;
  return { ok: true, installRoot: L.installRoot, project: L.project, current: id, previous: previousId(L), versions,
    service: descriptor ? { instanceId: descriptor.instanceId, build: descriptor.build ?? null, processId: descriptor.processId ?? null, runsFrom,
      runsFromCheckout: runsFrom ? inside(runsFrom, join(L.project, 'dist')) : null } : null,
    ledgerVersion: ledgerVersion(paths.ledger), versionUsers: versionUsers(L), checkoutDistUsers: checkoutUsers(L), pruneCandidates: pruneCandidates(L).map(entry => entry.id) };
}
export function prune(L) {
  const candidates = pruneCandidates(L);
  return { ok: true, keep: KEEP, candidates: candidates.map(entry => entry.id),
    ownerCommand: candidates.length ? `rm -rf ${candidates.map(entry => join(L.versions, entry.id)).join(' ')}` : null,
    note: 'listed only: deleting versions is the owner\'s step; a version in use by any process is never listed' };
}

export async function main(argv, env = process.env) {
  // /proc process custody and util-linux flock are prerequisites of this developer-only kit.
  if (process.platform !== 'linux') fail('DEV_RELEASE_PLATFORM_UNSUPPORTED', { platform: process.platform, supportedPlatforms: ['linux'] });
  const args = [...argv], flags = {};
  const take = name => { const at = args.indexOf(name); if (at < 0) return undefined; const value = args[at + 1]; if (!value || value.startsWith('--')) fail('DEV_RELEASE_USAGE', { option: name }, 2); args.splice(at, 2); return value; };
  const flag = name => { const at = args.indexOf(name); if (at >= 0) args.splice(at, 1); return at >= 0; };
  flags.node = resolve(take('--node') ?? process.execPath); flags.bwrap = take('--bwrap'); flags.remoteRef = take('--remote-ref') ?? 'origin/main';
  flags.waiveSmoke = (take('--waive-smoke') ?? '').split(',').filter(Boolean);
  flags.to = take('--to'); flags.confirm = take('--confirm'); flags.source = take('--source'); const launcher = take('--launcher');
  flags.stopTimeoutMs = Number(take('--stop-timeout-ms') ?? 90_000); flags.startTimeoutMs = Number(take('--start-timeout-ms') ?? 60_000);
  for (const name of ['allow-local', 'preview', 'keep-build', 'allow-same-version', 'restore-ledger', 'restore-state']) flags[name.replace(/-(\w)/gu, (_, c) => c.toUpperCase())] = flag(`--${name}`);
  const [command, value, ...rest] = args;
  if (rest.length || args.some(arg => arg.startsWith('--'))) fail('DEV_RELEASE_USAGE', { args }, 2);
  const L = layout({ env, launcher: launcher ? resolve(launcher) : undefined });
  if (command === 'stage' && value) return stage(L, value, flags);
  if (command === 'switch' && value) return switchTo(L, value, flags);
  if (command === 'rollback' && !value) return rollback(L, flags);
  if (command === 'start' && !value) return start(L, flags);
  if (command === 'status' && !value) return status(L, flags);
  if (command === 'prune' && !value) return prune(L);
  fail('DEV_RELEASE_USAGE', { usage: 'stage <commit> | switch <id> | rollback [--to <id>|checkout] [--restore-ledger [--confirm <token>]] [--restore-state] | start | status | prune' }, 2);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : result.exitCode ?? 1;
  }, error => {
    const out = error instanceof ReleaseError ? { ok: false, code: error.code, ...error.detail } : { ok: false, code: 'DEV_RELEASE_FAILED', message: String(error?.stack ?? error) };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 1;
  });
}
