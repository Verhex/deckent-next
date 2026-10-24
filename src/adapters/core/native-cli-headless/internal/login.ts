import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { refuse } from './contract.js';
import { headlessExecutable } from './connect.js';
import { buildHeadlessEnv, headlessLoginEnv } from './env.js';
import { loginRecordPath, withLoginLock } from './login-lock.js';
import { authStatus, emptyRunDir, privateDir } from './preflight.js';
import { headlessIsolationSeal, runHeadlessIsolated, type HeadlessIsolation } from './realm.js';

/** How the CLI's own sign-in ended (`cancelled`: the person stopped it; `failed`: a non-zero exit or the registry time bound). */
export type HeadlessLoginExit = 'completed' | 'cancelled' | 'failed';
/** What `models login` reports: the login dir, whether it is the Brain's own, how the sign-in ended and, from the CLI's own status afterwards,
 * the allowlisted login kind and plan only (never an account name, email, organization or token). */
export type HeadlessLoginResult = Readonly<{ schemaVersion: 1; configDir: string; owned: boolean; exit: HeadlessLoginExit; signedIn: boolean;
  authMethod: string | null; subscriptionType: string | null }>;
export type HeadlessLoginInput = Readonly<{ family: string; stateDir: string; configDir: string; owned: boolean; executable?: string | undefined; sso: boolean;
  env: Readonly<Record<string, string | undefined>>; now: () => number; isolation: HeadlessIsolation; signal?: AbortSignal }>;

/** s3c (owner 2026-10-24): the Brain's own login dir of a CLI family, `<resourceDir>/<registry CLI id>`, created 0700; refused typed when it is not a
 * private directory of this uid. Only its name and metadata are looked at, never a file in it. */
export async function headlessOwnedLoginDir(family: string, resourceDir: string): Promise<string> {
  const entry = nativeCliHeadless(family);
  if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const path = join(resourceDir, entry.id);
  await mkdir(path, { mode: 0o700 }).catch((error: { code?: unknown }) => { if (error.code !== 'EEXIST') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' }); });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  return realpath(path);
}
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : null;
/**
 * s3c: the CLI's own sign-in (registry argv, browser OAuth) in the person's terminal with inherited stdio — Deckent captures none of its bytes and
 * never sees a token. It is the one CLI spawn outside the realm (its sign-in needs the person's browser and sign-in hosts) and is reached only after
 * the caller's person check; it holds the login dir's lock (no Brain call beside it) for at most the registry bound. Afterwards the CLI's own
 * status, inside the realm, says whether the dir is signed in; Deckent records the time of the sign-in beside its lock so the next preflight re-runs.
 */
export async function runHeadlessLogin(input: HeadlessLoginInput): Promise<HeadlessLoginResult> {
  const entry = nativeCliHeadless(input.family), uid = process.getuid?.();
  if (!entry || uid === undefined) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  // Without its realm the login could never be used: refused before any search or spawn, like connect.
  await headlessIsolationSeal(input.isolation);
  const executable = await headlessExecutable(entry, input), { headless } = entry, runDir = join(input.stateDir, 'run');
  const config = await lstat(input.configDir).catch(() => null);
  if (!config?.isDirectory() || config.uid !== uid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  await privateDir(input.stateDir, uid); await privateDir(runDir, uid);
  const env = headlessLoginEnv(headless, input.env, input.configDir), args = [...headless.login.args, ...(input.sso ? [headless.login.ssoFlag] : [])];
  const exit = await withLoginLock(entry, input.configDir, input.stateDir, input.now, async (): Promise<HeadlessLoginExit> => {
    input.signal?.throwIfAborted();
    // Ctrl+C belongs to the sign-in (same foreground group): this process stays to release the lock and report. Synchronous, as for `$EDITOR`:
    // no event loop reads a key the CLI should get while it owns the terminal.
    const hold = () => undefined; process.on('SIGINT', hold);
    try {
      const run = spawnSync(executable, args, { stdio: 'inherit', shell: false, cwd: runDir, env, timeout: headless.login.timeoutMs, killSignal: 'SIGTERM' });
      if (run.error && (run.error as { code?: unknown }).code !== 'ETIMEDOUT') refuse('HEADLESS_CLI_UNAVAILABLE');
      return run.status === 0 ? 'completed' : run.signal === 'SIGINT' || run.status === 130 ? 'cancelled' : 'failed';
    } finally { process.off('SIGINT', hold); }
  }, input.signal);
  const record = loginRecordPath(input.configDir, input.stateDir), temporary = `${record}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, atMs: input.now(), exit }), { mode: 0o600, flag: 'wx' }); await rename(temporary, record);
  await emptyRunDir(runDir);
  const status = await runHeadlessIsolated(entry, input.isolation, { executable, args: headless.preflight.authStatusArgs, env: buildHeadlessEnv(headless, runDir, input.configDir),
    stateDir: input.stateDir, runDir, configDir: input.configDir, now: input.now }, { timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, input.signal);
  const auth = status.reason === 'exit' && !status.limit ? authStatus(Buffer.from(status.stdoutBase64, 'base64').toString('utf8')) : null;
  const signedIn = auth?.loggedIn === true && headless.auth.authMethods.includes(String(auth.authMethod)) && headless.auth.apiProviders.includes(String(auth.apiProvider))
    && (!headless.auth.configDirectoryMatch || auth.configDirectory === input.configDir);
  return Object.freeze({ schemaVersion: 1, configDir: input.configDir, owned: input.owned, exit, signedIn, authMethod: signedIn ? text(auth?.authMethod) : null,
    subscriptionType: signedIn ? text(auth?.subscriptionType) : null });
}
