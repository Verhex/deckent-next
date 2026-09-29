import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bubblewrapObservation, nativeShellKernelProbe, probeShellCapabilities, type BubblewrapCapability, type BubblewrapLauncher, type BubblewrapRestriction,
  type ShellCapabilities } from '#adapters/core/host-shell/index.js';
import { BUBBLEWRAP_BUNDLED } from './bundled.js';

/** Where a distribution installs bubblewrap; PATH is never consulted for the launcher (a PATH entry is data the command sees). */
export const BUBBLEWRAP_KNOWN_PATHS: readonly string[] = Object.freeze(['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']);
/** Owner S2 (2026-09-29): the oldest system bwrap used — 0.12.0 fixed GHSA-pxhw-h44j-8pfx / CVE-2026-87766. A distribution's backported
 * patch does not change the number and is not recognized; below it the system file is not used. */
export const BUBBLEWRAP_MINIMUM_SYSTEM_VERSION = '0.12.0';
/** `--overlay-src` / `--overlay` / `--tmp-overlay` arrived in 0.11.0 (NEWS, 2024-10-30); SHELL-OVERLAY reads `launcher.overlay`. */
export const BUBBLEWRAP_OVERLAY_VERSION = '0.11.0';
const BUNDLED_MAX_BYTES = 4 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 500, SMOKE_TIMEOUT_MS = 1_000;
/** The launcher's own run: every namespace the realm uses, a fresh /proc, our `true`, nothing of the caller's (env empty). */
const SMOKE_ARGS = ['--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'];
/** What bubblewrap prints when the kernel lets it create a user namespace without the capabilities to set it up, or not at all. */
const RESTRICTED = [/setting up uid map: Permission denied/u, /loopback: Failed RTM_NEW(?:ADDR|LINK)/u, /No permissions to create a new namespace/u,
  /[Cc]reating new namespace failed/u];
const APPARMOR_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const APPARMOR_HINT = 'AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1); an administrator can install '
  + 'this bwrap root-owned as /usr/local/bin/bwrap with an AppArmor profile that allows `userns` for it (see the shell sandbox documentation)';
const USERNS_HINT = 'the kernel refuses bubblewrap the user namespace it needs (check kernel.unprivileged_userns_clone, user.max_user_namespaces or a security module)';

export interface BubblewrapSelectOptions {
  /** The product state root: the bundled build runs from a verified copy in its `bin/` (0700). `null` → the bundled build is refused. */
  readonly stateDir: string | null;
  readonly systemPaths?: readonly string[];
  /** The bundled file in the package (default: `bundled/linux-<arch>/bwrap` beside this unit); `null` → none for this architecture. */
  readonly bundledPath?: string | null;
  readonly bundledSha256?: string | null;
  readonly bundledVersion?: string;
  /** Owners a system file and each of its directories may have (default root only); tests pass their own uid. */
  readonly trustedOwners?: readonly number[];
  /** The top of the directory walk for a system candidate (default `/`); tests pass their fixture root. */
  readonly ancestorRoot?: string;
  readonly minimumVersion?: string;
  /** Whether the kernel's AppArmor user-namespace restriction is on (default: the sysctl reads 1). */
  readonly apparmorRestricted?: () => boolean;
}

const versionOf = (text: string) => /^bubblewrap (\d+)\.(\d+)\.(\d+)$/u.exec(text.trim())?.slice(1, 4).map(Number) ?? null;
const atLeast = (version: string, minimum: string) => {
  const [a, b] = [versionOf(`bubblewrap ${version}`), versionOf(`bubblewrap ${minimum}`)];
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  return true;
};
const identityOf = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const errorText = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
/** Verified content per file identity (git-object cache pattern: content cannot change without the kernel advancing ctime). */
const verifiedCopies = new Map<string, string>();

/** The file rules every executed launcher meets: regular (never a symbolic link), executable, not writable by group or others, no
 * setuid/setgid, owned by a trusted owner. Null when it passes. */
function fileProblem(info: BigIntStats, owners: readonly number[]): string | null {
  if (info.isSymbolicLink()) return 'is a symbolic link';
  if (!info.isFile()) return 'is not a regular file';
  const mode = Number(info.mode);
  if ((mode & 0o111) === 0) return 'is not executable';
  if ((mode & 0o6000) !== 0) return 'is setuid or setgid';
  if ((mode & 0o022) !== 0) return 'is writable by group or others';
  if (!owners.includes(Number(info.uid))) return `is owned by uid ${info.uid}, not ${owners.join(' or ')}`;
  return null;
}

/** Every directory from the file's up to `top`: owned by a trusted owner and not writable by group or others (another principal could
 * otherwise replace the file). Null when they pass. */
function ancestorProblem(path: string, owners: readonly number[], top: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const info = lstatSync(dir, { bigint: true });
    if ((Number(info.mode) & 0o022) !== 0) return `directory ${dir} is writable by group or others`;
    if (!owners.includes(Number(info.uid))) return `directory ${dir} is owned by uid ${info.uid}`;
    if (dir === top || dir === dirname(dir)) return null;
  }
}

/** `--version` of a file that passed the rules above (env empty, bounded); the number, or why it is not usable. */
function queryVersion(path: string, signal: AbortSignal): Promise<{ readonly version: string } | { readonly reason: string }> {
  return new Promise(resolve => {
    execFile(path, ['--version'], { env: {}, timeout: VERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) { resolve({ reason: `--version failed (${errorText(error)})` }); return; }
      const parsed = versionOf(stdout);
      resolve(parsed ? { version: parsed.join('.') } : { reason: `unrecognized version output ${JSON.stringify(stdout.trim().slice(0, 60))}` });
    });
  });
}

type Candidate = { readonly ok: true; readonly launcher: BubblewrapLauncher } | { readonly ok: false; readonly reason: string } | null;

/** A system candidate (S1/S2): absent → null (not a rejection); a canonical path already tried (merged /usr) → null. */
async function systemCandidate(path: string, seen: Set<string>, options: BubblewrapSelectOptions, signal: AbortSignal): Promise<Candidate> {
  const owners = options.trustedOwners ?? [0];
  let info: BigIntStats, canonical: string;
  try { info = lstatSync(path, { bigint: true }); } catch { return null; }
  const problem = fileProblem(info, owners);
  if (problem) return { ok: false, reason: `bwrap at ${path} ${problem}` };
  try { canonical = realpathSync(path); } catch (error) { return { ok: false, reason: `bwrap at ${path} cannot be resolved (${errorText(error)})` }; }
  if (seen.has(canonical)) return null;
  seen.add(canonical);
  if (canonical !== path) info = lstatSync(canonical, { bigint: true });
  const ancestor = ancestorProblem(canonical, owners, options.ancestorRoot ?? '/');
  if (ancestor) return { ok: false, reason: `bwrap at ${path}: ${ancestor}` };
  const queried = await queryVersion(canonical, signal);
  if ('reason' in queried) return { ok: false, reason: `bwrap at ${path}: ${queried.reason}` };
  const minimum = options.minimumVersion ?? BUBBLEWRAP_MINIMUM_SYSTEM_VERSION;
  if (!atLeast(queried.version, minimum)) return { ok: false, reason: `bwrap at ${path}: version ${queried.version} is below the minimum ${minimum}` };
  return { ok: true, launcher: Object.freeze({ source: 'system', path: canonical, version: queried.version, sha256: null, overlay: atLeast(queried.version, BUBBLEWRAP_OVERLAY_VERSION),
    identity: identityOf(info) }) };
}

/** A copy under the state root that is ours and verifies: its identity, or null (absent, foreign or different — it will be rewritten). */
function verifiedCopy(path: string, expected: string): string | null {
  let info: BigIntStats;
  try { info = lstatSync(path, { bigint: true }); } catch { return null; }
  if (fileProblem(info, [process.getuid?.() ?? -1]) || info.nlink !== 1n) return null;
  const identity = identityOf(info);
  if (verifiedCopies.get(identity) === expected) return identity;
  let digest: string;
  try { digest = sha256(readFileSync(path)); } catch { return null; }
  if (digest !== expected) return null;
  if (verifiedCopies.size > 64) verifiedCopies.clear();
  verifiedCopies.set(identity, digest);
  return identity;
}

/**
 * The bundled build (S1 second choice): the package file's bytes are read once and hashed; the same bytes are written to
 * `<stateDir>/bin/bwrap-<sha256>` (a 0700 directory, file 0500, temporary + fsync + rename) and that copy is what runs. The package file's
 * mode is not a rule (umask 002 installs it 0775): only its content is, and the copy is ours alone.
 */
function bundledCandidate(options: BubblewrapSelectOptions): Candidate | { readonly none: string } {
  const path = options.bundledPath === undefined ? defaultBundledPath() : options.bundledPath;
  const expected = options.bundledSha256 === undefined ? BUBBLEWRAP_BUNDLED.sha256[process.arch] ?? null : options.bundledSha256;
  if (!path || !expected) return { none: `no bundled bubblewrap for linux-${process.arch} in this package` };
  let info: BigIntStats;
  try { info = lstatSync(path, { bigint: true }); } catch { return { none: `no bundled bubblewrap at ${path}` }; }
  if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: `bundled bwrap at ${path} is not a regular file` };
  if (info.size > BigInt(BUNDLED_MAX_BYTES)) return { ok: false, reason: `bundled bwrap at ${path} is larger than ${BUNDLED_MAX_BYTES} bytes` };
  if (!options.stateDir) return { ok: false, reason: 'no product state root to hold the verified bundled bwrap' };
  const bin = join(options.stateDir, 'bin'), target = join(bin, `bwrap-${expected}`);
  const version = options.bundledVersion ?? BUBBLEWRAP_BUNDLED.version;
  const launcher = (identity: string): Candidate => ({ ok: true, launcher: Object.freeze({ source: 'bundled', path: target, version, sha256: expected,
    overlay: atLeast(version, BUBBLEWRAP_OVERLAY_VERSION), identity }) });
  try {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const dir = lstatSync(bin);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.()) return { ok: false, reason: `${bin} is not a directory owned by this user` };
    if ((dir.mode & 0o077) !== 0) chmodSync(bin, 0o700);
    const existing = verifiedCopy(target, expected);
    if (existing) return launcher(existing);
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    if (digest !== expected) return { ok: false, reason: `bundled bwrap at ${path} does not match the shipped build (sha256 ${expected}); found ${digest}` };
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(temporary, 'wx', 0o500);
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { chmodSync(temporary, 0o500); renameSync(temporary, target); } catch (error) { rmSync(temporary, { force: true }); throw error; }
    const written = verifiedCopy(target, expected);
    return written ? launcher(written) : { ok: false, reason: `the bundled bwrap copy at ${target} did not verify after writing` };
  } catch (error) { return { ok: false, reason: `the bundled bwrap could not be placed under ${bin} (${errorText(error)})` }; }
}
const defaultBundledPath = () => fileURLToPath(new URL(`../bundled/linux-${process.arch}/bwrap`, import.meta.url));

/** The selected launcher's own run; `restricted` (typed, S3) when the kernel refused it the user namespace. */
function smoke(launcher: BubblewrapLauncher, options: BubblewrapSelectOptions, signal: AbortSignal): Promise<Pick<BubblewrapCapability, 'status' | 'restriction' | 'detail'>> {
  return new Promise(resolve => {
    execFile(launcher.path, SMOKE_ARGS, { env: {}, timeout: SMOKE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4_096, encoding: 'utf8', signal }, (error, _stdout, stderr) => {
      if (!error) { resolve({ status: 'available', restriction: null, detail: null }); return; }
      const line = (stderr.trim().split('\n')[0] ?? '').slice(0, 200) || errorText(error);
      if (!RESTRICTED.some(pattern => pattern.test(stderr))) { resolve({ status: 'unavailable', restriction: null, detail: `bwrap at ${launcher.path} could not start a sandbox: ${line}` }); return; }
      const apparmor = (options.apparmorRestricted ?? apparmorRestricted)();
      const restriction: BubblewrapRestriction = Object.freeze(apparmor ? { kind: 'apparmor', hint: APPARMOR_HINT } : { kind: 'user-namespace', hint: USERNS_HINT });
      resolve({ status: 'restricted', restriction, detail: `bwrap at ${launcher.path}: ${line}; ${restriction.hint}` });
    });
  });
}
const apparmorRestricted = () => { try { return readFileSync(APPARMOR_SYSCTL, 'utf8').trim() === '1'; } catch { return false; } };

/**
 * Selects the bubblewrap launcher (owner S1–S3, 2026-09-29) and runs it once: the first system candidate that is root-owned in
 * root-owned directories and at least the minimum, otherwise the bundled build (sha256-verified, run from its copy under the state
 * root). Every rejected candidate is named. The launcher's own run decides availability (a restricted user namespace is typed).
 */
export async function selectBubblewrapLauncher(options: BubblewrapSelectOptions, signal: AbortSignal = new AbortController().signal): Promise<BubblewrapCapability> {
  const rejected: { path: string; reason: string }[] = [], seen = new Set<string>();
  let chosen: BubblewrapLauncher | null = null;
  for (const path of options.systemPaths ?? BUBBLEWRAP_KNOWN_PATHS) {
    signal.throwIfAborted();
    const candidate = await systemCandidate(path, seen, options, signal);
    if (candidate?.ok) { chosen = candidate.launcher; break; }
    if (candidate) rejected.push({ path, reason: candidate.reason });
  }
  let none: string | null = null;
  if (!chosen) {
    const bundled = bundledCandidate(options);
    if (bundled && 'none' in bundled) none = bundled.none;
    else if (bundled?.ok) chosen = bundled.launcher;
    else if (bundled) rejected.push({ path: options.bundledPath ?? defaultBundledPath(), reason: bundled.reason });
  }
  if (!chosen) {
    const reasons = [...rejected.map(item => item.reason), ...(none ? [none] : [])];
    return bubblewrapObservation('unavailable', reasons.join('; ') || 'no bubblewrap launcher', Object.freeze(rejected));
  }
  const ran = await smoke(chosen, options, signal);
  return Object.freeze({ status: ran.status, launcher: chosen, rejected: Object.freeze(rejected), restriction: ran.restriction, detail: ran.detail });
}

/**
 * Re-checks a measured launcher before each use (synchronous; `usable()`): the file must still be the measured one. The bundled copy is
 * re-hashed when its identity moved (it may be rewritten with the same content); a moved system file means the service must measure again.
 */
export function verifyBubblewrapLauncher(launcher: BubblewrapLauncher): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let identity: string;
  try { identity = identityOf(lstatSync(launcher.path, { bigint: true })); } catch (error) { return { ok: false, reason: `bwrap at ${launcher.path} is gone (${errorText(error)})` }; }
  if (identity === launcher.identity) return { ok: true };
  if (launcher.source === 'bundled' && launcher.sha256 && verifiedCopy(launcher.path, launcher.sha256)) return { ok: true };
  return launcher.source === 'bundled' ? { ok: false, reason: `the bundled bwrap at ${launcher.path} no longer matches the shipped build (sha256 ${launcher.sha256})` }
    : { ok: false, reason: `bwrap at ${launcher.path} changed since the service measured it (restart the service to select again)` };
}

const measured = new Map<string, Promise<ShellCapabilities>>();
/** The process-wide host measurement (S5): started once by the service, shared by every turn and MCP start; restart to refresh it. The
 * bubblewrap launcher is selected with the product state root `stateDir` (null: the bundled build cannot be used). */
export function shellSandboxCapabilities(stateDir: string | null): Promise<ShellCapabilities> {
  const key = stateDir ?? '';
  let value = measured.get(key);
  if (!value) {
    value = probeShellCapabilities({ platform: process.platform, bubblewrap: signal => selectBubblewrapLauncher({ stateDir }, signal), kernel: nativeShellKernelProbe });
    measured.set(key, value);
  }
  return value;
}
