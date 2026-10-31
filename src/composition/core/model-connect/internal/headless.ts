import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ModelConnectCommand } from '#domain/index.js';
import { ModelConnectError, assertAuthorityWitness, type AuthorityWitness, type ConnectedAdapter } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, attestLocalInteractiveTerminal, headlessConnectionAdapter, headlessConsent, headlessOwnedLoginDir, localPrincipalChannel, localPrincipalPeer,
  prepareHeadlessConnection, readHeadlessLogins, readProviderConnectSeed, runHeadlessLogin, shellSandboxCapabilities, type HeadlessLoginResult,
  type ProviderConnectKind } from '#adapters/index.js';
import { ErrorRegistry, automationMarker, globalStateRoot, normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath,
  resolveGlobalScopePaths, resolveProductLayout, type ConfigLoadOptions } from '#platform/index.js';

type Env = NodeJS.ProcessEnv;
const stateRoot = (env: Env) => resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env).stateDir;
const loginsLayout = (env: Env) => { const root = stateRoot(env); return resolveProductLayout({ projectRoot: root, root }); };
export const configuredHeadlessLoginRoot = (options: ConfigLoadOptions = {}) => productResourcePath(loginsLayout(options.env ?? process.env), 'headlessLogins');
/** s3c (owner 2026-10-24): the Brain's own login dir of a CLI family under the global state root (layout `headlessLogins`, 0700, never backed up). */
async function ownedLoginDir(family: string, env: Env): Promise<string> {
  const resource = await prepareProductDirectory(loginsLayout(env), 'headlessLogins').catch(() => { throw ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: { check: 'state-dir' } }); });
  return headlessOwnedLoginDir(family, resource);
}
const isolation = (env: Env) => async () => (await shellSandboxCapabilities(globalStateRoot(env))).bubblewrap;
/** PV 2a: why a CLI subscription cannot run on this host before anything is chosen (the same typed refusal connect and login give), or null. */
export async function headlessIsolationRefusal(options: ConfigLoadOptions = {}): Promise<Error | null> {
  const capability = process.platform === 'linux' ? await isolation(options.env ?? process.env)().catch(() => null) : null;
  return capability?.status === 'available' && capability.launcher ? null
    : ErrorRegistry.createError('HEADLESS_ISOLATION_UNAVAILABLE', { params: { check: capability?.status === 'restricted' ? 'user-namespace' : 'launcher' } });
}
/** The person at this terminal: a controlling TTY and no AI-agent or CI marker of the installation's list (PV: an agent with a PTY tool is not the person). */
export const headlessPersonWitness = (env: Env, agents: readonly string[]): AuthorityWitness =>
  ({ attest: async () => automationMarker(env, agents) === null && await attestLocalInteractiveTerminal() });
/**
 * S3-3: the CLI kind's connect ports. The adapter part is prepared once per command after the engine's person check (S3-5: the isolation realm
 * first, then executable, login dir — s3c: the Brain's own unless the person names one —, uid, preflight inside the realm; no model call), and the
 * consent is the person's own choice on each written layer. State lives under the person's global state dir, one fixed dir per connection.
 */
export function headlessConnectPorts(command: ModelConnectCommand, options: ConfigLoadOptions, person: () => Promise<Readonly<{ issuer: string; subject: string }>>) {
  const env = options.env ?? process.env;
  const prepared = new Map<string, Promise<Readonly<{ base: Awaited<ReturnType<typeof prepareHeadlessConnection>>; protocol: Readonly<{ family: string; version: string }>; owned: string }>>>();
  const prepare = (kind: ProviderConnectKind, nativeId: string) => {
    const held = prepared.get(nativeId); if (held) return held;
    const next = (async () => {
    const seed = await readProviderConnectSeed(kind.connect!.seed!), model = seed.providers.flatMap(provider => provider.models).find(row => row.nativeId === nativeId);
    const protocol = model?.protocols.find(row => row.family === kind.connect!.protocolFamily), minCliVersion = (model as { minCliVersion?: string | null } | undefined)?.minCliVersion;
    if (!protocol || !minCliVersion) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    const stateDir = join(stateRoot(env), 'headless', createHash('sha256').update(JSON.stringify([kind.id, command.scopeId, nativeId])).digest('hex').slice(0, 16));
    const owned = await ownedLoginDir(protocol.family, env);
    return { protocol, owned, base: await prepareHeadlessConnection({ protocol, minCliVersion, stateDir, executable: command.cli?.executable, configDir: command.cli?.configDir,
      ownedConfigDir: owned, env, now: Date.now, isolation: isolation(env) }) };
    })(); prepared.set(nativeId, next); return next;
  };
  return {
    async adapter(kind: ProviderConnectKind, value: Readonly<{ nativeId: string; existing?: Record<string, unknown> | null }>): Promise<ConnectedAdapter> {
      const { base, protocol, owned } = await prepare(kind, value.nativeId), consent = headlessConsent(value.existing as never, command.delegate, await person(), Date.now());
      return { ...headlessConnectionAdapter({ ...base, delegatedUse: consent }, protocol), cli: { configDir: base.configDir, owned: base.configDir === owned, delegate: consent?.classes ?? [] } };
    },
  };
}
/** PV 3: the person check and the kind check of `models login`, then the Brain's own login dir (created 0700), so the `/provider` window can show it before anything starts. */
export async function headlessLoginDir(connection: string, options: ConfigLoadOptions, witness: AuthorityWitness) {
  await assertAuthorityWitness('models.login', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(item => item.id === connection), family = kind?.connect?.personOnly ? kind.connect.protocolFamily : undefined;
  if (!kind?.available || !family) throw ErrorRegistry.createError('MODEL_CONNECT_NOT_CONNECTABLE');
  return { family, owned: await ownedLoginDir(family, options.env ?? process.env) };
}
/** The doctor's Brain-login rows (no spawn, nothing created): s3c each connection says whether it uses the Brain's own login dir. */
export async function readConfiguredHeadlessLogins(section: unknown, scopeId: string, options: ConfigLoadOptions = {}) {
  const root = await realpath(configuredHeadlessLoginRoot(options)).catch(() => null);
  return readHeadlessLogins(section, scopeId, root);
}
export type HeadlessLoginCommand = Readonly<{ connection: string; configDir?: string | undefined; executable?: string | undefined; sso?: boolean | undefined }>;
/**
 * s3c `deckent models login`: the person signs the Brain's login dir in with the CLI's own sign-in in their terminal. A person's terminal act: an
 * MCP actor, or a caller without the local interactive-terminal witness, is refused before anything is created or started. `confirm` shows the
 * exact dir first (the person's card); false = nothing runs. The kind must be a person-only CLI kind with a headless step (registry data).
 */
export async function loginConfiguredHeadless(command: HeadlessLoginCommand, options: ConfigLoadOptions, confirm: (dir: Readonly<{ configDir: string; owned: boolean }>) => Promise<boolean>,
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<HeadlessLoginResult | null> {
  const { family, owned } = await headlessLoginDir(command.connection, options, witness), env = options.env ?? process.env;
  const configDir = command.configDir === undefined ? owned : isAbsolute(command.configDir) ? await realpath(command.configDir).catch(() => null) : null;
  if (!configDir) throw ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: { check: 'config-dir' } });
  if (!await confirm({ configDir, owned: configDir === owned })) return null;
  // Deckent's own state for this sign-in sits beside the connections' (the same per-login-dir lock), never in the login dir.
  const stateDir = join(stateRoot(env), 'headless', `login-${createHash('sha256').update(configDir).digest('hex').slice(0, 16)}`);
  return runHeadlessLogin({ family, stateDir, configDir, owned: configDir === owned, executable: command.executable, sso: command.sso === true, env, now: Date.now, isolation: isolation(env) });
}
