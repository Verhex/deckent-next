import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNodeProcess, type ProcessEvidence } from '#adapters/core/process-runner/index.js';
import { compareToolchainVersions } from '#engine/index.js';
import { refuse, type NativeCliHeadlessDefinition } from './contract.js';
import { buildHeadlessEnv, headlessFlagSetDigest, headlessRequiredFlags, type HeadlessEntry } from './env.js';

/** What a passing preflight proved for one executable state; the call's init guard compares the reported CLI version with it. */
export interface HeadlessPreflight { readonly version: string; readonly flagSetDigest: string; readonly runDir: string; readonly env: Readonly<Record<string, string>> }
/** Per process (every service start re-runs it): keyed by the executable's realpath, size, mtime and inode, config dir and registry revision. */
const passed = new Map<string, HeadlessPreflight>();
const AUTH_FIELDS = ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType', 'configDirectory'] as const;
async function privateDir(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'state-dir' });
}
/** Empties the connection's own run dir before a spawn (no project hooks, MCP file or instructions can accumulate in the CLI's cwd/HOME). */
export async function emptyRunDir(runDir: string): Promise<void> {
  for (const entry of await readdir(runDir)) await rm(join(runDir, entry), { recursive: true, force: true });
}
/** Field allowlist at the parser: account identity fields (email, organization) are dropped here and never reach a record or log. */
function authStatus(stdout: string): Partial<Record<(typeof AUTH_FIELDS)[number], unknown>> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(AUTH_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]));
  } catch { return null; }
}
/**
 * No model call: version range, every required flag (help or the hidden parser probe), and the login kind from `auth status`, all spawned
 * with the one built environment from the connection's run dir. Pass → per-process seal plus a 0600 record in the state dir; fail → typed
 * refusal and a closed record; the next call runs it again (a later pass reopens the channel). No API substitution exists on any path.
 */
export async function headlessPreflight(entry: HeadlessEntry, definition: NativeCliHeadlessDefinition, now: () => number, signal?: AbortSignal): Promise<HeadlessPreflight> {
  if (process.getuid?.() !== definition.ownerUid) refuse('HEADLESS_OWNER_MISMATCH');
  const executable = await realpath(definition.executable).catch(() => null), info = executable ? await stat(executable).catch(() => null) : null;
  if (!executable || executable !== definition.executable || !info?.isFile() || (info.mode & 0o111) === 0) refuse('HEADLESS_CLI_UNAVAILABLE');
  const config = await stat(definition.configDir).catch(() => null);
  if (!config?.isDirectory() || config.uid !== definition.ownerUid) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  const { headless, command } = entry, runDir = join(definition.stateDir, 'run'), flagSetDigest = headlessFlagSetDigest(entry);
  const key = JSON.stringify([executable, info.size, info.mtimeMs, info.ino, definition.configDir, definition.minCliVersion, flagSetDigest]);
  await privateDir(definition.stateDir, definition.ownerUid); await privateDir(runDir, definition.ownerUid);
  const cached = passed.get(key);
  if (cached) return cached;
  const env = buildHeadlessEnv(headless, runDir, definition.configDir);
  const record = async (body: Record<string, unknown>) => {
    const target = join(definition.stateDir, 'preflight.json'), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, checkedAtMs: now(), executable, version: null, flagSetDigest, revision: headless.revision, ...body }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  };
  const run = async (args: readonly string[]): Promise<ProcessEvidence & { stdout: string; stderr: string }> => {
    // No emptying here: another process's preflight must never remove an in-flight call's prompt file (only `send` empties, under maxInFlight).
    const result = await runNodeProcess({ schemaVersion: 1, requestId: randomUUID(), executable: executable, args: [...args], cwd: runDir, env,
      timeoutMs: headless.limits.preflightTimeoutMs, outputBytes: headless.limits.preflightOutputBytes }, signal);
    if (result.reason !== 'exit') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'spawn' });
    return { ...result, stdout: Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), stderr: Buffer.from(result.stderrBase64, 'base64').toString('utf8') };
  };
  try {
    const versionRun = await run(headless.preflight.versionArgs), version = new RegExp(headless.preflight.versionPattern, 'u').exec(versionRun.stdout.trim())?.[1] ?? null;
    if (versionRun.exitCode !== 0 || version === null || compareToolchainVersions(version, definition.minCliVersion) < 0) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'version' });
    const help = (await run(headless.preflight.helpArgs)).stdout.split(/[\s,=]+/u), probe = command.capabilities.maxTurns?.hiddenHelpProbe;
    for (const flag of headlessRequiredFlags(entry)) {
      if (help.includes(flag)) continue;
      if (!(flag === command.capabilities.maxTurns?.flag && probe && (await run(probe.args)).stderr.includes(probe.refusal))) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'flags' });
    }
    const auth = authStatus((await run(headless.preflight.authStatusArgs)).stdout);
    if (!auth || typeof auth.loggedIn !== 'boolean') refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'auth-status' });
    if (auth.loggedIn !== true || !headless.auth.authMethods.includes(String(auth.authMethod)) || !headless.auth.apiProviders.includes(String(auth.apiProvider))) refuse('HEADLESS_LOGIN_REQUIRED');
    if (headless.auth.configDirectoryMatch && auth.configDirectory !== definition.configDir) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
    const sealed = Object.freeze({ version: version, flagSetDigest, runDir, env });
    await record({ state: 'open', version, size: info.size, mtimeMs: info.mtimeMs,
      auth: { authMethod: auth.authMethod, apiProvider: auth.apiProvider, subscriptionType: typeof auth.subscriptionType === 'string' ? auth.subscriptionType : null } });
    passed.set(key, sealed); return sealed;
  } catch (error) {
    const code = (error as { code?: unknown }).code, params = (error as { params?: { check?: unknown } }).params;
    await record({ state: 'closed', refusal: typeof code === 'string' ? code : 'HEADLESS_PREFLIGHT_FAILED', check: typeof params?.check === 'string' ? params.check : null }).catch(() => undefined);
    throw error;
  }
}
