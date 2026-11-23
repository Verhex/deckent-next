import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessDiagnostic, markHeadlessLoginReturned, type DeckentError } from '#platform/index.js';
import { nativeCliAgent, nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { refuse } from './contract.js';
import { headlessExecutable } from './connect.js';
import { resolveHeadlessExecutable } from './executable.js';
import { buildHeadlessEnv, headlessLoginEnv } from './env.js';
import { loginRecordPath, withLoginLock } from './login-lock.js';
import { configReadRefusal, emptyRunDir, headlessAuth, privateDir } from './preflight.js';
import { headlessIsolationSeal, runHeadlessIsolated, type HeadlessIsolation } from './realm.js';
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type HeadlessLoginExit = 'completed' | 'cancelled' | 'failed';
export type HeadlessLoginResult = Readonly<{ schemaVersion: 1; configDir: string; owned: boolean; exit: HeadlessLoginExit; signedIn: boolean; authMethod: string | null; subscriptionType: string | null; statusIssue?: DeckentError }>;
type HeadlessLoginInput = Readonly<{ family: string; stateDir: string; configDir: string; owned: boolean; executable?: string | undefined; sso: boolean; loginMethod?: string | undefined; env: Readonly<Record<string, string | undefined>>; now: () => number; isolation: HeadlessIsolation; signal?: AbortSignal }>;
function headlessLoginArgs(family: string, method: string | undefined, sso: boolean): readonly string[] {
  const entry = nativeCliHeadless(family), selected = method === undefined ? undefined : nativeCliAgent(family)?.agent.loginMethods.find(row => row.method === method);
  if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'login-family' });
  if (method !== undefined && !selected) refuse('HEADLESS_REQUEST_INVALID', { reason: 'login-method' });
  if (sso && !entry.headless.login.ssoFlag) refuse('HEADLESS_REQUEST_INVALID', { reason: 'sso' });
  return [...(selected?.args ?? entry.headless.login.args), ...(sso ? [entry.headless.login.ssoFlag!] : [])];
}
export async function headlessOwnedLoginDir(family: string, resourceDir: string): Promise<string> {
  const entry = nativeCliHeadless(family); if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'login-family' });
  const path = join(resourceDir, entry.id);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') configReadRefusal(error); });
  const info = await lstat(path).catch(configReadRefusal);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'private-entry-refused' });
  return realpath(path).catch(configReadRefusal);
}
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : null;
/** Person-witnessed caller only: inherited stdio captures no login bytes; the lock and isolated status probe remain mandatory. */
export async function runHeadlessLogin(input: HeadlessLoginInput): Promise<HeadlessLoginResult> {
  const entry = nativeCliHeadless(input.family), uid = process.getuid?.();
  if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'login-family' });
  if (uid === undefined) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'program-owner-unverified' });
  const args = headlessLoginArgs(input.family, input.loginMethod, input.sso); await headlessIsolationSeal(input.isolation);
  const executable = await headlessExecutable(entry, input), { headless } = entry, runDir = join(input.stateDir, 'run');
  const config = await lstat(input.configDir).catch(configReadRefusal);
  if (!config.isDirectory()) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'not-directory' });
  if (config.uid !== uid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'untrusted-owner' });
  await privateDir(input.stateDir, uid); await privateDir(runDir, uid);
  let commandReturned = false;
  const env = headlessLoginEnv(headless, input.env, input.configDir), exit = await withLoginLock(entry, input.configDir, input.stateDir, input.now, async (): Promise<HeadlessLoginExit> => {
    input.signal?.throwIfAborted();
    const hold = () => undefined; process.on('SIGINT', hold);
    try {
      let run: ReturnType<typeof spawnSync>;
      try { run = spawnSync(executable, args, { stdio: 'inherit', shell: false, cwd: runDir, env, timeout: headless.login.timeoutMs, killSignal: 'SIGTERM' }); }
      catch { refuse('HEADLESS_CLI_UNAVAILABLE', { check: 'login-launch-unverified' }); }
      if (run.error && (run.error as { code?: unknown }).code !== 'ETIMEDOUT') refuse('HEADLESS_CLI_UNAVAILABLE', { check: 'login-launch-unverified' });
      commandReturned = true;
      return run.status === 0 ? 'completed' : run.signal === 'SIGINT' || run.status === 130 ? 'cancelled' : 'failed';
    } finally { process.off('SIGINT', hold); }
  }, input.signal).catch((error: unknown) => { if (commandReturned) markHeadlessLoginReturned(error); throw error; });
  const record = loginRecordPath(input.configDir, input.stateDir), temporary = `${record}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, atMs: input.now(), exit }), { mode: 0o600, flag: 'wx' })
    .catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'login-record-write', exit }));
  await rename(temporary, record).catch(() => refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'login-record-rename', exit }));
  return finishSignIn(input, entry, executable, runDir, uid, exit).catch(markHeadlessLoginReturned);
}

async function finishSignIn(input: HeadlessLoginInput, entry: NonNullable<ReturnType<typeof nativeCliHeadless>>, executable: string,
  runDir: string, uid: number, exit: HeadlessLoginExit): Promise<HeadlessLoginResult> {
  await emptyRunDir(runDir, 'login-status');
  const { headless } = entry;
  const program = await resolveHeadlessExecutable(entry, executable, uid, input.executable === undefined ? 'path' : 'new');
  const status = await runHeadlessIsolated(entry, input.isolation, { executable: program.executable, program, args: headless.preflight.authStatusArgs, env: buildHeadlessEnv(headless, runDir, input.configDir),
    stateDir: input.stateDir, runDir, configDir: input.configDir, now: input.now }, { timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, input.signal);
  const decoded = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
  const auth = status.reason === 'exit' && !status.limit ? headlessAuth(headless.auth, { exitCode: status.exitCode, stdout: decoded(status.stdoutBase64), stderr: decoded(status.stderrBase64) }, input.configDir) : null;
  const signedIn = auth?.state === 'signed-in';
  const statusIssue = status.limit ? headlessDiagnostic('HEADLESS_LIMIT_REACHED', { limit: status.limit })
    : auth?.state === 'signed-out' ? headlessDiagnostic('HEADLESS_LOGIN_REQUIRED', { reason: auth.reason })
      : auth?.state === 'config-dir' ? headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: auth.reason })
        : !auth ? headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'login-status-incomplete' })
          : auth.state === 'unreadable' ? headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'auth-status' })
            : status.exitCode !== 0 ? headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'login-status-positive-nonzero' }) : undefined;
  return Object.freeze({ schemaVersion: 1, configDir: input.configDir, owned: input.owned, exit, signedIn, authMethod: signedIn ? text(auth.authMethod) : null, subscriptionType: signedIn ? text(auth.subscriptionType) : null,
    ...(statusIssue && { statusIssue }) });
}
