import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeckentError, isRecord, readHeadlessDiagnosticCase, type HeadlessPreflightParams } from '#platform/index.js';
import { compareToolchainVersions } from '#engine/index.js';
import { refuse, type NativeCliHeadlessDefinition } from './contract.js';
import { buildHeadlessEnv, headlessFlagSetDigest, headlessRequiredFlags, type HeadlessEntry } from './env.js';
import { headlessIsolationSeal, runHeadlessIsolated, type HeadlessIsolation, type HeadlessIsolationSeal } from './realm.js';
import { loginRecordPath } from './login-lock.js';
import { headlessExecutableRefusal, resolveHeadlessExecutable, type HeadlessExecutable } from './executable.js';

/** The verified program for this preflight and its caller. Every spawn binds that file and the init guard checks its reported version. */
export interface HeadlessPreflight { readonly executable: string; readonly program: HeadlessExecutable; readonly version: string; readonly flagSetDigest: string; readonly runDir: string; readonly env: Readonly<Record<string, string>>;
  readonly isolation: HeadlessIsolationSeal }
/** Per process. The chosen path, launcher, rule and native file identity must all match a passing isolated check. */
const passed = new Map<string, HeadlessPreflight>();
const AUTH_FIELDS = ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType', 'configDirectory'] as const;
export async function privateDir(path: string, uid: number): Promise<void> {
  const failed = () => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir', reason: 'unverified' });
  await mkdir(path, { recursive: true, mode: 0o700 }).catch(failed);
  const info = await lstat(path).catch(failed);
  if (!info.isDirectory()) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir', reason: 'not-directory' });
  if (info.uid !== uid || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir', reason: 'not-private' });
}

/** A missing login directory and unsuccessful verification carry distinct evidence. */
export function configReadRefusal(error: NodeJS.ErrnoException): never {
  return refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir',
    reason: error.code === 'ENOENT' ? 'missing' : error.code === 'ENOTDIR' ? 'not-directory' : 'unverified' });
}
/** Empties the connection's own run dir before a spawn (no project hooks, MCP file or instructions can accumulate in the CLI's cwd/HOME). */
export async function emptyRunDir(runDir: string, purpose?: 'login-status'): Promise<void> {
  const entries = await readdir(runDir).catch((error: unknown) => {
    if (purpose === 'login-status') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'login-status-run-list' });
    throw error;
  });
  for (const entry of entries) await rm(join(runDir, entry), { recursive: true, force: true }).catch((error: unknown) => {
    if (purpose === 'login-status') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'login-status-run-remove' });
    throw error;
  });
}
/** Field allowlist at the parser: account identity fields (email, organization) are dropped here and never reach a record or log. */
function authStatus(stdout: string): Partial<Record<(typeof AUTH_FIELDS)[number], unknown>> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(AUTH_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
  } catch { return null; }
}
/** The CLI's own login status, by registry data: `json` (allowlisted fields on stdout, the login dir it names) or `status` (the exit code and one exact
 * line; another exit-0 login kind, such as an API key, is not a subscription login). `unreadable`: neither shape (a typed preflight refusal). */
type HeadlessAuth = Readonly<{ state: 'signed-in'; authMethod: string; apiProvider: string | null; subscriptionType: string | null }>
  | Readonly<{ state: 'signed-out'; reason: 'status-unconfirmed' | 'reported-signed-out' | 'subscription-unconfirmed' }>
  | Readonly<{ state: 'unreadable' }>
  | Readonly<{ state: 'config-dir'; reason: 'reported-mismatch' | 'unreported' }>;
export function headlessAuth(auth: HeadlessEntry['headless']['auth'], output: Readonly<{ exitCode: number | null; stdout: string; stderr: string }>, configDir: string): HeadlessAuth {
  if ('kind' in auth) {
    const lines = (auth.stream === 'stderr' ? output.stderr : output.stdout).split(/\r?\n/u).map(line => line.trim()), match = auth.loggedIn.find(row => lines.includes(row.line));
    return output.exitCode === 0 && match ? { state: 'signed-in', authMethod: match.authMethod, apiProvider: null, subscriptionType: null }
      : output.exitCode === 0 || output.exitCode === 1 ? { state: 'signed-out', reason: 'status-unconfirmed' } : { state: 'unreadable' };
  }
  const fields = authStatus(output.stdout);
  if (!fields || typeof fields.loggedIn !== 'boolean') return { state: 'unreadable' };
  if (!fields.loggedIn) return { state: 'signed-out', reason: 'reported-signed-out' };
  if (!auth.authMethods.includes(String(fields.authMethod)) || !auth.apiProviders.includes(String(fields.apiProvider)))
    return { state: 'signed-out', reason: 'subscription-unconfirmed' };
  if (auth.configDirectoryMatch && fields.configDirectory !== configDir) return { state: 'config-dir',
    reason: typeof fields.configDirectory === 'string' && fields.configDirectory !== '' ? 'reported-mismatch' : 'unreported' };
  return { state: 'signed-in', authMethod: String(fields.authMethod), apiProvider: String(fields.apiProvider), subscriptionType: typeof fields.subscriptionType === 'string' ? fields.subscriptionType : null };
}
/**
 * No model call: version range, every required flag (help or the hidden parser probe), and the login kind from `auth status`, all spawned
 * with the one built environment from the connection's run dir, inside the realm (S3-5). Pass → per-process seal plus a 0600 record in the state
 * dir; fail → typed refusal and a closed record; the next call runs it again (a later pass reopens the channel). No API substitution and no
 * unisolated spawn exist on any path: an unusable realm is refused typed before any spawn, on every check.
 */
export async function headlessPreflight(entry: HeadlessEntry, definition: NativeCliHeadlessDefinition, now: () => number, isolation: HeadlessIsolation,
  signal?: AbortSignal, agent?: Readonly<{ flagSetDigest: string; requiredFlags: readonly string[] }>, selection?: 'new' | 'path'): Promise<HeadlessPreflight> {
  const uid = process.getuid?.();
  if (uid === undefined) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'program-owner-unverified' });
  if (uid !== definition.ownerUid) refuse('HEADLESS_OWNER_MISMATCH');
  const program = await resolveHeadlessExecutable(entry, definition.executable, definition.ownerUid, selection), { executable } = program;
  const versionRefusal = (params: Extract<HeadlessPreflightParams, { check: 'version' }>) => headlessExecutableRefusal(params, program.chosen, executable);
  const config = await stat(definition.configDir).catch(configReadRefusal);
  if (!config.isDirectory()) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'not-directory' });
  if (config.uid !== definition.ownerUid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'untrusted-owner' });
  const { headless, command } = entry, runDir = join(definition.stateDir, 'run'), flagSetDigest = agent?.flagSetDigest ?? headlessFlagSetDigest(entry);
  await privateDir(definition.stateDir, definition.ownerUid); await privateDir(runDir, definition.ownerUid);
  const record = async (body: Record<string, unknown>) => {
    const target = join(definition.stateDir, 'preflight.json'), temporary = `${target}.${randomUUID()}.tmp`;
    const writeFailed = () => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'preflight-record-write' });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, checkedAtMs: now(), executable: entry.command.executable, version: null, flagSetDigest, revision: headless.revision, ...body }),
      { mode: 0o600, flag: 'wx' }).catch(writeFailed);
    await rename(temporary, target).catch(writeFailed);
  };
  const closed = async (error: unknown): Promise<never> => {
    const refusal = error instanceof DeckentError ? readHeadlessDiagnosticCase({ code: error.code, params: error.params }) : null;
    await record({ state: 'closed', refusal, check: refusal?.params['check'] ?? null }).catch(() => undefined);
    throw error;
  };
  // S3-5: checked on every call, cached or not: a launcher that is gone or changed closes the channel before any claim.
  const seal = await headlessIsolationSeal(isolation).catch(closed), isolated = Object.freeze({ launcher: seal.launcher, version: seal.version });
  // s3c: a sign-in through `models login` since the last check (Deckent's own record, not the login dir) re-runs it: the account may have changed.
  const login = await stat(loginRecordPath(definition.configDir, definition.stateDir)).then(record => [record.ino, record.mtimeMs], () => null);
  const revision = headlessExecutableRevision(entry, program);
  const key = JSON.stringify([revision, definition.stateDir, definition.configDir, definition.minCliVersion, flagSetDigest, seal.path, seal.version, login]);
  const cached = passed.get(key);
  if (cached) return cached;
  const env = buildHeadlessEnv(headless, runDir, definition.configDir);
  const run = async (args: readonly string[], cwd = runDir, spawnEnv = env, configDir = definition.configDir) => {
    // No emptying here: another process's preflight must never remove an in-flight call's prompt file (only `send` empties, under maxInFlight).
    const result = await runHeadlessIsolated(entry, isolation, { executable, program, args, env: spawnEnv, stateDir: definition.stateDir, runDir: cwd, configDir, now },
      { timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, signal);
    if (result.limit) refuse('HEADLESS_LIMIT_REACHED', { limit: result.limit });
    if (result.signalFromTrailer) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'relay-signal-diagnostic' });
    if (result.reason === 'signal' || result.reason === 'cancelled') refuse('HEADLESS_PREFLIGHT_FAILED', { check: result.reason });
    if (result.reason !== 'exit') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'spawn', reason: result.reason });
    return { ...result, stdout: Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(result.stderrBase64, 'base64').toString('utf8') };
  };
  try {
    const versionRun = await run(headless.preflight.versionArgs);
    if (versionRun.exitCode !== 0) versionRefusal(versionRun.exitCode !== null && versionRun.exitCode > 0 && versionRun.exitCode <= 255
      ? { check: 'version', reason: 'exit', exitCode: String(versionRun.exitCode) } : { check: 'version', reason: 'exit-unrenderable' });
    const version = verifiedCliVersion(new RegExp(headless.preflight.versionPattern, 'u').exec(versionRun.stdout.trim())?.[1]);
    if (version === null) return versionRefusal({ check: 'version', reason: 'unreadable' });
    if (compareToolchainVersions(version, definition.minCliVersion) < 0) versionRefusal(verifiedCliVersion(definition.minCliVersion) !== null ? { check: 'version', reason: 'too-old', version, minimum: definition.minCliVersion }
      : { check: 'version', reason: 'too-old-unrenderable' });
    if (versionRun.cleanupError) throw versionRun.cleanupError;
    const helpRun = await run(headless.preflight.helpArgs);
    const help = helpRun.stdout.split(/[\s,=]+/u), hidden = new Map(headless.preflight.hiddenFlags.map(row => [row.flag, row.probe]));
    // A hidden flag is proven by the parser refusing a bad value, in an empty temporary config dir: the probe never sees the person's login.
    const accepted = async (probe: NonNullable<ReturnType<typeof hidden.get>>) => {
      const capability = command.capabilities.maxTurns?.hiddenHelpProbe, shape = probe === 'max-turns-capability' ? capability && { args: capability.args, refusal: [capability.refusal] } : probe;
      if (!shape) return false;
      const empty = await mkdtemp(join(definition.stateDir, 'probe-'))
        .catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'probe-scratch-create' }));
      let confirmed = false;
      try {
        const output = await run(shape.args, empty, buildHeadlessEnv(headless, empty, empty), empty);
        const matched = shape.refusal.every(text => `${output.stderr}\n${output.stdout}`.includes(text));
        if (matched && output.cleanupError) throw output.cleanupError;
        confirmed = matched;
        return confirmed;
      }
      finally { await rm(empty, { recursive: true, force: true }).catch(() => {
        if (confirmed) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'probe-scratch-remove' });
      }); }
    };
    for (const flag of agent?.requiredFlags ?? headlessRequiredFlags(entry)) {
      const probe = hidden.get(flag);
      if (probe !== undefined && helpRun.cleanupError) throw helpRun.cleanupError;
      if (probe === undefined ? !help.includes(flag) : !(await accepted(probe))) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'flags',
        reason: probe === undefined ? 'help-unverified' : 'parser-unverified' });
    }
    if (helpRun.cleanupError) throw helpRun.cleanupError;
    const status = await run(headless.preflight.authStatusArgs);
    const auth = headlessAuth(headless.auth, status, definition.configDir);
    if (auth.state === 'signed-out') refuse('HEADLESS_LOGIN_REQUIRED', { reason: auth.reason });
    if (auth.state === 'config-dir') refuse('HEADLESS_PREFLIGHT_FAILED', { check: auth.state, reason: auth.reason });
    if (auth.state !== 'signed-in') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'auth-status' });
    if (status.cleanupError) throw status.cleanupError;
    const current = await resolveHeadlessExecutable(entry, program.chosen, definition.ownerUid, 'recheck');
    if (current.identity !== program.identity) headlessExecutableRefusal({ check: 'executable-changed' }, program.chosen, executable);
    const sealed = Object.freeze({ executable, program, version, flagSetDigest, runDir, env, isolation: isolated });
    // S7: the version an earlier passing check of this connection proved, kept while it differs (the doctor's "CLI updated A → B" note).
    const prior = await readFile(join(definition.stateDir, 'preflight.json'), 'utf8')
      .then(raw => JSON.parse(raw) as unknown, () => null)
      .catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'preflight-record-unreadable' }));
    const identified = isIdentifiedOpenPreflight(prior) && isSealedPreflightRecord(prior) ? prior : null;
    const priorVersion = verifiedCliVersion(identified?.['version']);
    const updatedFrom = priorVersion !== null && compareToolchainVersions(priorVersion, version) !== 0
      ? priorVersion : null;
    await record({ state: 'open', executable: program.packageRoot ? entry.command.executable : executable, revision, version, updatedFrom, size: program.size, mtimeMs: program.mtimeMs, isolation: isolated,
      auth: { authMethod: auth.authMethod, apiProvider: auth.apiProvider, subscriptionType: auth.subscriptionType } });
    passed.set(key, sealed); return sealed;
  } catch (error) { return closed(error); }
}

export function isIdentifiedOpenPreflight(record: unknown): record is Record<string, unknown> {
  return isRecord(record) && record['state'] === 'open'
    && typeof record['revision'] === 'string' && record['revision'].trim().length > 0
    && typeof record['executable'] === 'string' && record['executable'].trim().length > 0
    && typeof record['size'] === 'number' && Number.isSafeInteger(record['size']) && record['size'] >= 0
    && typeof record['mtimeMs'] === 'number' && Number.isFinite(record['mtimeMs']);
}

function isSealedPreflightRecord(record: Record<string, unknown>): boolean {
  return (record['schemaVersion'] === 1 || record['schemaVersion'] === 2)
    && typeof record['revision'] === 'string' && /^.+:[a-f0-9]{64}$/u.test(record['revision']);
}

// The record's existing revision field binds registry semantics to this installation's identity.
export const headlessExecutableRevision = (entry: HeadlessEntry, program: HeadlessExecutable) => `${entry.headless.revision}:${program.identity}`;
export const verifiedCliVersion = (input: unknown) => typeof input === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(input) ? input : null;
