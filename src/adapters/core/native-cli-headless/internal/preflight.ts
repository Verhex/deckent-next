import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessEvidence } from '#adapters/core/process-runner/index.js';
import { compareToolchainVersions } from '#engine/index.js';
import { refuse, type NativeCliHeadlessDefinition } from './contract.js';
import { buildHeadlessEnv, headlessFlagSetDigest, headlessRequiredFlags, type HeadlessEntry } from './env.js';
import { headlessIsolationSeal, runHeadlessIsolated, type HeadlessIsolation, type HeadlessIsolationSeal } from './realm.js';
import { loginRecordPath } from './login-lock.js';

/** What a passing preflight proved for one executable state; the call's init guard compares the reported CLI version with it. */
export interface HeadlessPreflight { readonly version: string; readonly flagSetDigest: string; readonly runDir: string; readonly env: Readonly<Record<string, string>>;
  readonly isolation: HeadlessIsolationSeal }
/** Per process (every service start re-runs it): keyed by the executable's realpath, size, mtime and inode, config dir, registry revision and the
 * realm's launcher (S3-5: a passing check is always an isolated one). */
const passed = new Map<string, HeadlessPreflight>();
const AUTH_FIELDS = ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType', 'configDirectory'] as const;
export async function privateDir(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' });
}
/** Empties the connection's own run dir before a spawn (no project hooks, MCP file or instructions can accumulate in the CLI's cwd/HOME). */
export async function emptyRunDir(runDir: string): Promise<void> {
  for (const entry of await readdir(runDir)) await rm(join(runDir, entry), { recursive: true, force: true });
}
/** Field allowlist at the parser: account identity fields (email, organization) are dropped here and never reach a record or log. */
export function authStatus(stdout: string): Partial<Record<(typeof AUTH_FIELDS)[number], unknown>> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(AUTH_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
  } catch { return null; }
}
/** The CLI's own login status, by registry data: `json` (allowlisted fields on stdout, the login dir it names) or `status` (the exit code and one exact
 * line; another exit-0 login kind, such as an API key, is not a subscription login). `unreadable`: neither shape (a typed preflight refusal). */
export type HeadlessAuth = Readonly<{ state: 'signed-in'; authMethod: string; apiProvider: string | null; subscriptionType: string | null }>
  | Readonly<{ state: 'signed-out' | 'unreadable' | 'config-dir' }>;
export function headlessAuth(auth: HeadlessEntry['headless']['auth'], output: Readonly<{ exitCode: number | null; stdout: string; stderr: string }>, configDir: string): HeadlessAuth {
  if ('kind' in auth) {
    const lines = (auth.stream === 'stderr' ? output.stderr : output.stdout).split(/\r?\n/u).map(line => line.trim()), match = auth.loggedIn.find(row => lines.includes(row.line));
    return output.exitCode === 0 && match ? { state: 'signed-in', authMethod: match.authMethod, apiProvider: null, subscriptionType: null }
      : output.exitCode === 0 || output.exitCode === 1 ? { state: 'signed-out' } : { state: 'unreadable' };
  }
  const fields = authStatus(output.stdout);
  if (!fields || typeof fields.loggedIn !== 'boolean') return { state: 'unreadable' };
  if (fields.loggedIn !== true || !auth.authMethods.includes(String(fields.authMethod)) || !auth.apiProviders.includes(String(fields.apiProvider))) return { state: 'signed-out' };
  if (auth.configDirectoryMatch && fields.configDirectory !== configDir) return { state: 'config-dir' };
  return { state: 'signed-in', authMethod: String(fields.authMethod), apiProvider: String(fields.apiProvider), subscriptionType: typeof fields.subscriptionType === 'string' ? fields.subscriptionType : null };
}
/**
 * No model call: version range, every required flag (help or the hidden parser probe), and the login kind from `auth status`, all spawned
 * with the one built environment from the connection's run dir, inside the realm (S3-5). Pass → per-process seal plus a 0600 record in the state
 * dir; fail → typed refusal and a closed record; the next call runs it again (a later pass reopens the channel). No API substitution and no
 * unisolated spawn exist on any path: an unusable realm is refused typed before any spawn, on every check.
 */
export async function headlessPreflight(entry: HeadlessEntry, definition: NativeCliHeadlessDefinition, now: () => number, isolation: HeadlessIsolation,
  signal?: AbortSignal): Promise<HeadlessPreflight> {
  if (process.getuid?.() !== definition.ownerUid) refuse('HEADLESS_OWNER_MISMATCH');
  const executable = await realpath(definition.executable).catch(() => null), info = executable ? await stat(executable).catch(() => null) : null;
  if (!executable || executable !== definition.executable || !info?.isFile() || (info.mode & 0o111) === 0) refuse('HEADLESS_CLI_UNAVAILABLE');
  const config = await stat(definition.configDir).catch(() => null);
  if (!config?.isDirectory() || config.uid !== definition.ownerUid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  const { headless, command } = entry, runDir = join(definition.stateDir, 'run'), flagSetDigest = headlessFlagSetDigest(entry);
  await privateDir(definition.stateDir, definition.ownerUid); await privateDir(runDir, definition.ownerUid);
  const record = async (body: Record<string, unknown>) => {
    const target = join(definition.stateDir, 'preflight.json'), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, checkedAtMs: now(), executable, version: null, flagSetDigest, revision: headless.revision, ...body }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  };
  const closed = async (error: unknown): Promise<never> => {
    const code = (error as { code?: unknown }).code, params = (error as { params?: { check?: unknown } }).params;
    await record({ state: 'closed', refusal: typeof code === 'string' ? code : 'HEADLESS_PREFLIGHT_FAILED', check: typeof params?.check === 'string' ? params.check : null }).catch(() => undefined);
    throw error;
  };
  // S3-5: checked on every call, cached or not: a launcher that is gone or changed closes the channel before any claim.
  const seal = await headlessIsolationSeal(isolation).catch(closed), isolated = Object.freeze({ launcher: seal.launcher, version: seal.version });
  // s3c: a sign-in through `models login` since the last check (Deckent's own record, not the login dir) re-runs it: the account may have changed.
  const login = await stat(loginRecordPath(definition.configDir, definition.stateDir)).then(record => [record.ino, record.mtimeMs], () => null);
  const key = JSON.stringify([executable, info.size, info.mtimeMs, info.ino, definition.configDir, definition.minCliVersion, flagSetDigest, seal.path, seal.version, login]);
  const cached = passed.get(key);
  if (cached) return cached;
  const env = buildHeadlessEnv(headless, runDir, definition.configDir);
  const run = async (args: readonly string[], cwd = runDir, spawnEnv = env, configDir = definition.configDir): Promise<ProcessEvidence & { stdout: string; stderr: string }> => {
    // No emptying here: another process's preflight must never remove an in-flight call's prompt file (only `send` empties, under maxInFlight).
    const result = await runHeadlessIsolated(entry, isolation, { executable, args, env: spawnEnv, stateDir: definition.stateDir, runDir: cwd, configDir, now },
      { timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, signal);
    if (result.limit) refuse('HEADLESS_LIMIT_REACHED', { limit: result.limit });
    if (result.reason !== 'exit') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'spawn' });
    return { ...result, stdout: Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(result.stderrBase64, 'base64').toString('utf8') };
  };
  try {
    const versionRun = await run(headless.preflight.versionArgs), version = new RegExp(headless.preflight.versionPattern, 'u').exec(versionRun.stdout.trim())?.[1] ?? null;
    if (versionRun.exitCode !== 0 || version === null || compareToolchainVersions(version, definition.minCliVersion) < 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'version' });
    const help = (await run(headless.preflight.helpArgs)).stdout.split(/[\s,=]+/u), hidden = new Map(headless.preflight.hiddenFlags.map(row => [row.flag, row.probe]));
    // A hidden flag is proven by the parser refusing a bad value, in an empty temporary config dir: the probe never sees the person's login.
    const accepted = async (probe: NonNullable<ReturnType<typeof hidden.get>>) => {
      const capability = command.capabilities.maxTurns?.hiddenHelpProbe, shape = probe === 'max-turns-capability' ? capability && { args: capability.args, refusal: [capability.refusal] } : probe;
      if (!shape) return false;
      const empty = await mkdtemp(join(definition.stateDir, 'probe-'));
      try { const output = await run(shape.args, empty, buildHeadlessEnv(headless, empty, empty), empty); return shape.refusal.every(text => `${output.stderr}\n${output.stdout}`.includes(text)); }
      finally { await rm(empty, { recursive: true, force: true }); }
    };
    for (const flag of headlessRequiredFlags(entry)) {
      const probe = hidden.get(flag);
      if (probe === undefined ? !help.includes(flag) : !(await accepted(probe))) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'flags' });
    }
    const auth = headlessAuth(headless.auth, await run(headless.preflight.authStatusArgs), definition.configDir);
    if (auth.state === 'signed-out') refuse('HEADLESS_LOGIN_REQUIRED');
    if (auth.state !== 'signed-in') refuse('HEADLESS_PREFLIGHT_FAILED', { check: auth.state === 'config-dir' ? 'config-dir' : 'auth-status' });
    const sealed = Object.freeze({ version: version, flagSetDigest, runDir, env, isolation: isolated });
    await record({ state: 'open', version, size: info.size, mtimeMs: info.mtimeMs, isolation: isolated,
      auth: { authMethod: auth.authMethod, apiProvider: auth.apiProvider, subscriptionType: auth.subscriptionType } });
    passed.set(key, sealed); return sealed;
  } catch (error) { return closed(error); }
}
