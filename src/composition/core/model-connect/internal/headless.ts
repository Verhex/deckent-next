import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_DELEGATED_CLASSES, type ModelConnectCommand, type ModelInvocationProfile } from '#domain/index.js';
import { ModelConnectError, assertAuthorityWitness, configuredInvocationProfiles, prepareSubscriptionConsent, type AuthorityWitness, type ConnectedAdapter } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, attestLocalInteractiveTerminal, headlessConnectionAdapter, headlessOwnedLoginDir, localPrincipalChannel, localPrincipalPeer,
  bindCapacityResource, headlessCapacityBinding, invocationCapacityResource, nativeCliAgent, openSqliteLedger, openSqliteLedgerReadOnly, readHeadlessSealedVersion,
  prepareHeadlessConnection, readHeadlessLogins, readProviderConnectSeed, runHeadlessLogin, type HeadlessLoginResult,
  type ProviderConnectKind } from '#adapters/index.js';
import { nativeCliHeadlessDefinitionSchema } from '#capabilities/index.js';
import { configuredBubblewrap } from '#composition/core/model-invocation/index.js';
import { ErrorRegistry, automationMarker, inspectNativeStateCustody, normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath,
  resolveGlobalScopePaths, resolveProductLayout, type ConfigLoadOptions } from '#platform/index.js';
import type { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
type Env = NodeJS.ProcessEnv;
const stateRoot = (env: Env) => resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env).stateDir;
const loginsLayout = (env: Env) => { const root = stateRoot(env); return resolveProductLayout({ projectRoot: root, root }); };
export const configuredHeadlessLoginRoot = (options: ConfigLoadOptions = {}) => productResourcePath(loginsLayout(options.env ?? process.env), 'headlessLogins');
/** s3c (owner 2026-10-24): the Brain's own login dir of a CLI family under the global state root (layout `headlessLogins`, 0700, never backed up). */
async function ownedLoginDir(family: string, env: Env): Promise<string> {
  const resource = await prepareProductDirectory(loginsLayout(env), 'headlessLogins').catch(() => { throw ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: { check: 'state-dir' } }); });
  return headlessOwnedLoginDir(family, resource);
}
/** PV 2a: why a CLI subscription cannot run on this host before anything is chosen (the same typed refusal connect and login give), or null. */
export async function headlessIsolationRefusal(options: ConfigLoadOptions = {}): Promise<Error | null> {
  const capability = process.platform === 'linux' ? await configuredBubblewrap(options)().catch(() => null) : null;
  return capability?.status === 'available' && capability.launcher ? null
    : ErrorRegistry.createError('HEADLESS_ISOLATION_UNAVAILABLE', { params: { check: capability?.status === 'restricted' ? 'user-namespace' : 'launcher' } });
}
/** The person at this terminal: a controlling TTY and no AI-agent or CI marker of the installation's list (PV: an agent with a PTY tool is not the person). */
export const headlessPersonWitness = (env: Env, agents: readonly string[]): AuthorityWitness =>
  ({ attest: async () => automationMarker(process.env, agents) === null && automationMarker(env, agents) === null && await attestLocalInteractiveTerminal() });
// Preparation runs after the person check, once per model. Consent remains specific to each authored layer.
export function headlessConnectPorts(command: ModelConnectCommand, options: ConfigLoadOptions,
  ledger: (access: 'read' | 'write') => ReturnType<typeof loadConfiguredScopeContext>) {
  const env = options.env ?? process.env;
  let seed: ReturnType<typeof readProviderConnectSeed> | undefined;
  const seedTarget = async (kind: ProviderConnectKind, nativeId: string) => {
    const { providers } = await (seed ??= readProviderConnectSeed(kind.connect!.seed!));
    const model = providers.flatMap(provider => provider.models).find(row => row.nativeId === nativeId);
    const protocol = model?.protocols.find(row => row.family === kind.connect!.protocolFamily);
    if (!protocol || !model?.minCliVersion) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    const stateDir = join(stateRoot(env), 'headless', createHash('sha256').update(JSON.stringify([kind.id, command.scopeId, nativeId])).digest('hex').slice(0, 16));
    return { protocol, minCliVersion: model.minCliVersion, stateDir, providers };
  };
  const prepared = new Map<string, ReturnType<typeof prepare>>();
  async function prepare({ protocol, minCliVersion, stateDir }: Awaited<ReturnType<typeof seedTarget>>) {
    const owned = await ownedLoginDir(protocol.family, env);
    const base = await prepareHeadlessConnection({ protocol, minCliVersion, stateDir, ...command.cli, ownedConfigDir: owned,
      env, now: Date.now, isolation: configuredBubblewrap(options) });
    return { protocol, owned, base };
  }
  const source = ({ installationId, config, principal }: Awaited<ReturnType<typeof ledger>>) => ({
    schemaVersion: 1 as const, installationId: installationId!, companyId: config.company.id, scopeId: command.scopeId,
    principal: { issuer: principal.issuer, subject: principal.subject },
  });
  const shape = async (definition: Parameters<typeof headlessConnectionAdapter>[0], protocol: Parameters<typeof headlessConnectionAdapter>[1], owned: string | null) => {
    const adapter = headlessConnectionAdapter(definition, protocol), custody = await inspectNativeStateCustody(definition, env);
    return { ...adapter, cli: { configDir: definition.configDir, owned: definition.configDir === owned, delegate: definition.delegatedUse?.classes ?? [],
      ...(custody === 'outside-installation' ? { governedUse: 'outside-installation' as const } : {}) } };
  };
  const bindings = new Map<string, { binding: ReturnType<typeof headlessCapacityBinding>; slots: number }>();
  return {
    async observe(kind: ProviderConnectKind, nativeId: string, profile: ModelInvocationProfile) {
      const { cli } = command, existing = profile.adapter.definition, parsed = nativeCliHeadlessDefinitionSchema.safeParse(existing);
      if (!parsed.success || !cli?.executable || !cli.configDir) return null;
      const definition = parsed.data, context = await ledger('read');
      if (!context.installationId || !context.projectId || context.identity.installation.pendingWrite || !isDeepStrictEqual(definition.sourceBinding, source(context))) return null;
      const { protocol, minCliVersion, stateDir } = await seedTarget(kind, nativeId);
      if (cli.executable !== definition.executable || cli.configDir !== definition.configDir || definition.ownerUid !== context.ownerUid
        || definition.stateDir !== stateDir || definition.minCliVersion !== minCliVersion || await realpath(cli.configDir).catch(() => null) !== definition.configDir
        || !await readHeadlessSealedVersion(definition, protocol.family)) return null;
      const login = await lstat(definition.configDir).catch(() => null);
      if (!login?.isDirectory() || login.uid !== definition.ownerUid) return null;
      const consent = prepareSubscriptionConsent(existing, command.delegate, context.principal, Date.now());
      if (!isDeepStrictEqual(consent, definition.delegatedUse)) return null;
      const agent = nativeCliAgent(protocol.family);
      if (!agent) return null;
      const owned = await realpath(join(configuredHeadlessLoginRoot(options), agent.id)).catch(() => null);
      const adapter = await shape(definition, protocol, owned);
      const db = await context.path().then(path => openSqliteLedgerReadOnly(path, context.config.storage.sqlite)).catch(() => null);
      if (!db) return null;
      try {
        const held = invocationCapacityResource(db, profile);
        return held?.capacity.executionSlots === adapter.maxInFlight && held.capacity.inFlightSlots === adapter.maxInFlight ? adapter : null;
      } catch { return null; } finally { db.close(); }
    },
    async commit() {
      const context = await ledger('write'), db = openSqliteLedger(await context.path(), context.config.storage.sqlite, 'forbid');
      try {
        for (const { binding, slots } of bindings.values()) bindCapacityResource(db, binding, { executionSlots: slots, inFlightSlots: slots });
      } finally { db.close(); }
    },
    async adapter(kind: ProviderConnectKind, value: Readonly<{ nativeId: string; existing?: Record<string, unknown> | null }>): Promise<ConnectedAdapter> {
      const observed = await ledger('read');
      const context = observed.installationId ? observed : await ledger('write');
      if (!context.installationId) throw ErrorRegistry.createError('NATIVE_AGENT_RECONNECT_REQUIRED');
      const target = await seedTarget(kind, value.nativeId), sourceBinding = source(context);
      const existing = [value.existing, ...configuredInvocationProfiles(context.config).filter(({ scopeId, reference }) =>
        scopeId === command.scopeId && target.providers.some(provider => provider.id === reference.providerId && provider.version === reference.providerVersion
          && provider.models.some(model => model.nativeId === value.nativeId && model.id === reference.modelId && model.version === reference.modelVersion)))
        .map(profile => profile.adapter.definition)];
      if (existing.some(definition => {
        if (definition?.['sourceBinding'] === undefined) return false;
        const parsed = nativeCliHeadlessDefinitionSchema.safeParse(definition);
        return !parsed.success || !isDeepStrictEqual(parsed.data.sourceBinding, sourceBinding);
      }))
        throw ErrorRegistry.createError('PROJECT_ATTACHMENT_DENIED');
      let preparation = prepared.get(value.nativeId);
      if (!preparation) { preparation = prepare(target); prepared.set(value.nativeId, preparation); }
      const { base, protocol, owned } = await preparation, consent = prepareSubscriptionConsent(value.existing as never,
        command.delegate ?? (existing.some(Boolean) ? undefined : DEFAULT_DELEGATED_CLASSES), context.principal, Date.now()); // a first connect takes the owner default
      const definition = { ...base, delegatedUse: consent, sourceBinding }, adapter = await shape(definition, protocol, owned);
      bindings.set(value.nativeId, { binding: headlessCapacityBinding(definition), slots: adapter.maxInFlight });
      return adapter;
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
  return readHeadlessLogins(section, scopeId, root, async (definition, family) => {
    const custody = await inspectNativeStateCustody(definition, options.env);
    const connection = family && PROVIDER_CONNECT_REGISTRY.kinds.find(kind => kind.connect?.protocolFamily === family)?.id;
    return { ...(custody === 'outside-installation' ? { governedUse: custody } : {}), ...(connection ? { connection } : {}) };
  });
}
export type HeadlessLoginCommand = Readonly<{ connection: string; configDir?: string | undefined; executable?: string | undefined; sso?: boolean | undefined; loginMethod?: string | undefined }>;
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
  return runHeadlessLogin({ family, stateDir, configDir, owned: configDir === owned, executable: command.executable, sso: command.sso === true, loginMethod: command.loginMethod, env, now: Date.now, isolation: configuredBubblewrap(options) });
}
