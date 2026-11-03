import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeCliAgent, nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { refuse } from './contract.js';
import { headlessExecutable } from './connect.js';
import { buildHeadlessEnv, headlessLoginEnv } from './env.js';
import { loginRecordPath, withLoginLock } from './login-lock.js';
import { emptyRunDir, headlessAuth, privateDir } from './preflight.js';
import { headlessIsolationSeal, runHeadlessIsolated, type HeadlessIsolation } from './realm.js';
export type HeadlessLoginExit = 'completed' | 'cancelled' | 'failed';
export type HeadlessLoginResult = Readonly<{ schemaVersion: 1; configDir: string; owned: boolean; exit: HeadlessLoginExit; signedIn: boolean; authMethod: string | null; subscriptionType: string | null }>;
export type HeadlessLoginInput = Readonly<{ family: string; stateDir: string; configDir: string; owned: boolean; executable?: string | undefined; sso: boolean; loginMethod?: string | undefined; env: Readonly<Record<string, string | undefined>>; now: () => number; isolation: HeadlessIsolation; signal?: AbortSignal }>;
export function headlessLoginArgs(family: string, method: string | undefined, sso: boolean): readonly string[] {
  const entry = nativeCliHeadless(family), selected = method === undefined ? undefined : nativeCliAgent(family)?.agent.loginMethods.find(row => row.method === method);
  if (!entry || method !== undefined && !selected) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  if (sso && !entry.headless.login.ssoFlag) refuse('HEADLESS_REQUEST_INVALID', { reason: 'sso' });
  return [...(selected?.args ?? entry.headless.login.args), ...(sso ? [entry.headless.login.ssoFlag!] : [])];
}
export async function headlessOwnedLoginDir(family: string, resourceDir: string): Promise<string> {
  const entry = nativeCliHeadless(family); if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const path = join(resourceDir, entry.id); await mkdir(path, { mode: 0o700 }).catch((error: { code?: unknown }) => { if (error.code !== 'EEXIST') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' }); });
  const info = await lstat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  return realpath(path);
}
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : null;
/** Person-witnessed caller only: inherited stdio captures no login bytes; the lock and isolated status probe remain mandatory. */
export async function runHeadlessLogin(input: HeadlessLoginInput): Promise<HeadlessLoginResult> {
  const entry = nativeCliHeadless(input.family), uid = process.getuid?.(); if (!entry || uid === undefined) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  const args = headlessLoginArgs(input.family, input.loginMethod, input.sso); await headlessIsolationSeal(input.isolation);
  const executable = await headlessExecutable(entry, input), { headless } = entry, runDir = join(input.stateDir, 'run');
  const config = await lstat(input.configDir).catch(() => null); if (!config?.isDirectory() || config.uid !== uid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  await privateDir(input.stateDir, uid); await privateDir(runDir, uid);
  const env = headlessLoginEnv(headless, input.env, input.configDir), exit = await withLoginLock(entry, input.configDir, input.stateDir, input.now, async (): Promise<HeadlessLoginExit> => {
    input.signal?.throwIfAborted();
    const hold = () => undefined; process.on('SIGINT', hold);
    try { const run = spawnSync(executable, args, { stdio: 'inherit', shell: false, cwd: runDir, env, timeout: headless.login.timeoutMs, killSignal: 'SIGTERM' });
      if (run.error && (run.error as { code?: unknown }).code !== 'ETIMEDOUT') refuse('HEADLESS_CLI_UNAVAILABLE');
      return run.status === 0 ? 'completed' : run.signal === 'SIGINT' || run.status === 130 ? 'cancelled' : 'failed';
    } finally { process.off('SIGINT', hold); }
  }, input.signal);
  const record = loginRecordPath(input.configDir, input.stateDir), temporary = `${record}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, atMs: input.now(), exit }), { mode: 0o600, flag: 'wx' }); await rename(temporary, record);
  await emptyRunDir(runDir);
  const status = await runHeadlessIsolated(entry, input.isolation, { executable, args: headless.preflight.authStatusArgs, env: buildHeadlessEnv(headless, runDir, input.configDir),
    stateDir: input.stateDir, runDir, configDir: input.configDir, now: input.now }, { timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, input.signal);
  const decoded = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
  const auth = status.reason === 'exit' && !status.limit ? headlessAuth(headless.auth, { exitCode: status.exitCode, stdout: decoded(status.stdoutBase64), stderr: decoded(status.stderrBase64) }, input.configDir) : null, signedIn = auth?.state === 'signed-in';
  return Object.freeze({ schemaVersion: 1, configDir: input.configDir, owned: input.owned, exit, signedIn, authMethod: signedIn ? text(auth.authMethod) : null, subscriptionType: signedIn ? text(auth.subscriptionType) : null });
}
