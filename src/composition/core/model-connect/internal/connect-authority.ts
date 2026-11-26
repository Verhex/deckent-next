import { isDeepStrictEqual } from 'node:util';
import { type ModelConnectCommand, type ModelReference, type ProviderCatalogDocument } from '#domain/index.js';
import { evaluateConfigWrite, subscriptionActor, ModelCatalogPolicyAuthorization, ModelActivationPolicyAuthorization, ModelConnectApplication, modelActivationPolicyRule, type ModelConnectPorts } from '#engine/index.js';
import { discoveredProviderCatalog, providerDiscoveryChannel, nativeCliHeadlessDefinitionSchema, localPrincipalChannel, localPrincipalPeer, SIWC_INFERENCE, type ProviderConnectKind } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { assertConfiguredActivationWitness, configuredAgentMarked, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { authorizeSiwcConnect } from './siwc.js';
import { listConfiguredConnectionWorkspaces, type ModelDiscoveryHost } from './discovery.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Verdict = Readonly<{ ruleId: string | null; decision?: string; effect?: string }>;
const hold = () => ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
/** As on the activation side: a later policy document stops connect only when a deciding grant, its terms or its verdict changes. */
function decidingGrants() {
  const rechecks: ((now: Context) => Promise<void>)[] = [];
  return {
    record<T extends Verdict>(context: Context, decision: T, decide: (at: Context) => T | Promise<T>) {
      const terms = (at: Context, { ruleId, decision: verdict, effect }: Verdict) =>
        [ruleId, verdict ?? effect, ruleId === null ? null : modelActivationPolicyRule(at.document, at.principal, ruleId)];
      const basis = terms(context, decision), { document } = context;
      rechecks.push(async now => {
        if (now.document === document || isDeepStrictEqual(now.document, document)) return;
        const fresh = await Promise.resolve().then(() => decide(now)).catch(() => { throw hold(); });
        if (!isDeepStrictEqual(terms(now, fresh), basis)) throw hold();
      });
      return decision;
    },
    async recheck(now: Context) { for (const check of rechecks) await check(now); },
  };
}

export function connectAuthority(root: string, command: ModelConnectCommand, options: ConfigLoadOptions, kind: ProviderConnectKind) {
  const { scopeId } = command;
  type Layers = Awaited<ReturnType<ModelConnectPorts['layers']>>;
  const readCatalog = (channelId: string) => inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId, channelId }, options, { modelUse: false }).then(result => result.channels[0]);
  const catalogs = new Map<string, ReturnType<typeof readCatalog>>();
  const inspect = (channelId: string) => {
    const result = catalogs.get(channelId);
    if (result) return result;
    const pending = readCatalog(channelId); catalogs.set(channelId, pending); return pending;
  };
  const read = () => loadConfiguredScopeContext(root, scopeId, options, 'read');
  let initial: Context | undefined;
  const channel = localPrincipalChannel(), peer = localPrincipalPeer();
  let witnessed = false;
  const { record, recheck } = decidingGrants();
  const current = async () => {
    const now = await read();
    initial ??= now;
    if (channel !== localPrincipalChannel() || peer !== localPrincipalPeer() || !isDeepStrictEqual(initial.principal, now.principal)
      || !isDeepStrictEqual(initial.layout, now.layout) || initial.config.company.id !== now.config.company.id
      || !isDeepStrictEqual(initial.config.cli.agentEnvironment, now.config.cli.agentEnvironment) && configuredAgentMarked(initial, options) !== configuredAgentMarked(now, options)
      || initial.installationId !== null && initial.installationId !== now.installationId
      || initial.projectId !== null && initial.projectId !== now.projectId) throw hold();
    await recheck(now);
    return now;
  };
  const attest = async (context: Context, fresh = false) => {
    if (fresh || !witnessed) await assertConfiguredActivationWitness('models.connect', context, options);
    witnessed = true;
    return context;
  };
  const witness = async () => attest(await current());
  const channelFor = (base: string | null) => kind.connect!.seed ?? providerDiscoveryChannel(kind, base);
  const catalog = async (context: Context, channelId: string, modelId: string | null, action: 'activate' | 'inspect' = 'activate', level: 'scope' | 'installation' = 'scope') => {
    const decide = (at: Context) => new ModelCatalogPolicyAuthorization(contextPolicySource(at, at.document)).authorize(action, scopeId, { channelId, modelId }, at.principal, level);
    return record(context, await decide(context), decide);
  };
  const chat = async (context: Context, reference: ModelReference) => {
    const decide = (at: Context) => new ModelActivationPolicyAuthorization(contextPolicySource(at, at.document)).authorize('activate', { scopeId, reference }, at.principal);
    return record(context, await decide(context), decide);
  };
  const config = (context: Context, writes: readonly { layer: 'global' | 'project'; keyPath: string }[]) => {
    for (const item of writes) {
      const decide = (at: Context) => evaluateConfigWrite(at.document, at.principal, { ...item, commandId: command.commandId, scopeId, principal: at.principal });
      record(context, decide(context), decide);
    }
  };
  const workerFacts = async (reference: ModelReference, registration: ProviderCatalogDocument | null, reading = inspect) =>
    ModelConnectApplication.workerFacts(await reading(reference.providerId), reference, registration, Date.now());
  const plannedWorkers = new Map<string, Awaited<ReturnType<typeof workerFacts>>>();
  const key = (reference: ModelReference) => JSON.stringify(reference);
  const probeTarget = async (context: Context, base: string, nativeId: string, layers: Layers) => {
    const { id: providerId, version: providerVersion, models: [model] } = discoveredProviderCatalog(kind, base, nativeId).providers[0]!;
    const reference = { providerId, providerVersion, modelId: model!.id, modelVersion: model!.version };
    await catalog(context, providerId, null);
    await catalog(context, providerId, nativeId);
    await chat(context, reference);
    if (!(await workerFacts(reference, null)).model) await catalog(context, providerId, null, 'activate', 'installation');
    knownWrites(context, layers, reference, true);
  };
  const knownWrites = (context: Context, layers: Layers, reference: ModelReference, declare: boolean) =>
    config(context, ModelConnectApplication.knownWrites(layers, scopeId, reference, declare, !kind.connect!.catalogOnly || kind.connect!.headless === true));
  const hasOAuth = kind.connect?.adapter === SIWC_INFERENCE.adapter.id;
  const native = kind.connect?.chatPath === null && kind.connect.personOnly && !hasOAuth;
  const local = native && Boolean(kind.connect?.seed) && !command.workspaceId;
  const mightWithdraw = local && command.delegate !== undefined;
  const mightObserve = local && !('pull' in command.model) && Boolean(command.cli?.executable && command.cli.configDir);
  const withdrawal = async (plan: Parameters<NonNullable<ModelConnectPorts['beforeAdapter']>>[0], layers: Layers) => {
    if (!mightWithdraw) return false;
    const context = await current(), { principalClass, owner } = subscriptionActor(context.principal);
    return principalClass === 'person' && context.installationId !== null
      && ModelConnectApplication.narrowsDelegation(command, layers, plan, owner, input => {
        const definition = nativeCliHeadlessDefinitionSchema.safeParse(input);
        return definition.success && Boolean(definition.data.sourceBinding)
          && (command.cli?.configDir === undefined || command.cli.configDir === definition.data.configDir)
          && (command.cli?.executable === undefined || command.cli.executable === definition.data.executable);
      });
  };
  const beforeDiscovery = async (base: string | null, layers: Layers, host: ModelDiscoveryHost) => {
    const listed = 'pull' in command.model && Boolean(kind.probe?.listsModels);
    const discovery = hasOAuth || Boolean(command.workspaceId) || listed || !kind.connect!.seed && 'nativeId' in command.model;
    const custody = kind.connect!.chatPath === null && (!kind.connect!.catalogOnly || kind.connect!.headless);
    if (mightWithdraw && command.delegate?.length === 0 && subscriptionActor((await current()).principal).principalClass !== 'person')
      throw ErrorRegistry.createError('HEADLESS_PERSON_REQUIRED');
    if (!discovery && (!custody || mightWithdraw || mightObserve)) return;
    await discoveryAuthority(base, layers, host, discovery);
  };
  const discoveryAuthority = async (base: string | null, layers: Layers, host: ModelDiscoveryHost, discovery: boolean) => {
    const context = await witness();
    const channelId = 'reference' in command.model ? command.model.reference.providerId : channelFor(base);
    await catalog(context, channelId, null);
    if (discovery) await catalog(context, channelFor(base), null, 'inspect');
    if ('reference' in command.model) { await chat(context, command.model.reference); knownWrites(context, layers, command.model.reference, false); }
    const secret = hasOAuth ? await authorizeSiwcConnect(context, scopeId, command.subscription?.connectionId, { root, options, command }) : undefined;
    if (secret) record(context, await secret(context), secret);
    if (!kind.connect!.seed && 'nativeId' in command.model) await probeTarget(context, base ?? '', command.model.nativeId, layers);
    if (command.workspaceId) {
      const rows = await listConfiguredConnectionWorkspaces(root, scopeId, kind.id, base, options, host);
      if (!rows.some(row => row.id === command.workspaceId)) throw ErrorRegistry.createError('MODEL_CONNECT_MODEL_UNKNOWN');
    }
  };
  const targets = async (plan: Parameters<NonNullable<ModelConnectPorts['beforeAdapter']>>[0], context: Context, observation = false) => {
    const currentCatalogs = new Map<string, ReturnType<typeof readCatalog>>();
    for (const target of plan.registrationTargets) await catalog(context, target.channelId, target.modelId, 'activate', 'installation');
    for (const item of plan.selections) {
      if (plan.profiled && !observation) await chat(context, item.reference);
      const expected = plannedWorkers.get(key(item.reference));
      if (!expected) continue;
      const channelId = item.reference.providerId;
      if (!currentCatalogs.has(channelId)) currentCatalogs.set(channelId, readCatalog(channelId));
      const worker = await workerFacts(item.reference, null, () => currentCatalogs.get(channelId)!);
      const required = !observation && (item.worker || item.activate || kind.connect!.catalogOnly === true);
      for (const id of ModelConnectApplication.workerTargets(expected, worker, required, item.worker, Date.now()))
        await catalog(context, channelId, id);
    }
  };
  const writtenChannels = new Map<string, { state: 'active'; revision: number }>();
  return { current, initial: () => initial!, witness, attest, inspect, beforeDiscovery, mightWithdraw, mightObserve, withdrawal, discoveryAuthority, targets, config,
    authorizeCarry: (reference: ModelReference) => chat(initial!, reference),
    async applyWorker(reference: ModelReference, write: () => Promise<boolean>) {
      const parent = ModelConnectApplication.assertWorkerWrite(plannedWorkers.get(key(reference)),
        await workerFacts(reference, null, readCatalog), writtenChannels.get(reference.providerId));
      const result = await write();
      if (result && parent?.state !== 'active') writtenChannels.set(reference.providerId, { state: 'active', revision: (parent?.revision ?? 0) + 1 });
      return result;
    },
    async beforeProbes(base: string, ids: readonly string[], layers: Layers) {
      if (!('pull' in command.model) || !ids.length) return;
      const context = await current();
      catalogs.clear();
      for (const id of ids) await probeTarget(context, base, id, layers);
    },
    async workerNeeded(reference: ModelReference, registering: ProviderCatalogDocument | null) {
      const facts = await workerFacts(reference, registering);
      plannedWorkers.set(key(reference), facts);
      const { channel, model, modelId } = facts;
      return modelId !== undefined && (channel?.access !== 'allowed' || channel.activation?.state !== 'active' || model?.activation?.state !== 'active');
    },
  };
}
