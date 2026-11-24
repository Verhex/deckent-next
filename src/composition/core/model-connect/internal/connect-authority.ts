import { isDeepStrictEqual } from 'node:util';
import { delegatedUseConsentSchema, type ModelConnectCommand, type ModelReference, type ProviderCatalogDocument } from '#domain/index.js';
import { configuredInvocationProfiles, evaluateConfigWrite, subscriptionActor, ModelCatalogPolicyAuthorization, ModelActivationPolicyAuthorization, refuseRetiredModelActivation, isRetiredCatalogModel, type ModelConnectPorts } from '#engine/index.js';
import { discoveredProviderCatalog, providerDiscoveryChannel, nativeCliHeadlessDefinitionSchema, localPrincipalChannel, localPrincipalPeer, SIWC_INFERENCE, type ProviderConnectKind } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { assertConfiguredActivationWitness, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { authorizeSiwcConnect } from './siwc.js';
import { listConfiguredConnectionWorkspaces, type ModelDiscoveryHost } from './discovery.js';

export function connectAuthority(root: string, command: ModelConnectCommand, options: ConfigLoadOptions, kind: ProviderConnectKind) {
  const scopeId = command.scopeId;
  const read = () => loadConfiguredScopeContext(root, scopeId, options, 'read');
  let initial: Awaited<ReturnType<typeof read>> | undefined;
  const channel = localPrincipalChannel(), peer = localPrincipalPeer();
  let witnessed = false;
  const current = async () => {
    const now = await read();
    initial ??= now;
    if (channel !== localPrincipalChannel() || peer !== localPrincipalPeer() || !isDeepStrictEqual(initial.principal, now.principal) || !isDeepStrictEqual(initial.document, now.document)
      || !isDeepStrictEqual(initial.layout, now.layout) || initial.config.company.id !== now.config.company.id
      || !isDeepStrictEqual(initial.config.cli.agentEnvironment, now.config.cli.agentEnvironment)
      || initial.installationId !== null && initial.installationId !== now.installationId
      || initial.projectId !== null && initial.projectId !== now.projectId) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    return now;
  };
  const witness = async (fresh = false) => {
    const context = await current();
    if (fresh || !witnessed) await assertConfiguredActivationWitness('models.connect', context, options);
    witnessed = true;
  };
  const channelFor = (base: string | null) => kind.connect!.seed ?? providerDiscoveryChannel(kind, base);
  const catalog = async (channelId: string, modelId: string | null, action: 'activate' | 'inspect' = 'activate', level: 'scope' | 'installation' = 'scope') => {
    const context = await current();
    await new ModelCatalogPolicyAuthorization(contextPolicySource(context, context.document)).authorize(action, scopeId, { channelId, modelId }, context.principal, level);
  };
  const chat = async (reference: ModelReference) => {
    const context = await current();
    await new ModelActivationPolicyAuthorization(contextPolicySource(context, context.document)).authorize('activate', { scopeId, reference }, context.principal);
  };
  const config = async (writes: readonly { layer: 'global' | 'project'; keyPath: string }[]) => {
    const context = await current();
    for (const item of writes) evaluateConfigWrite(context.document, context.principal, { ...item, commandId: command.commandId, scopeId, principal: context.principal });
  };
  const workerFacts = async (ref: ModelReference, registration: ProviderCatalogDocument | null) => {
    const channel = (await inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId, channelId: ref.providerId }, options, { modelUse: false })).channels[0];
    const model = channel?.access === 'allowed' && channel.providerVersion === ref.providerVersion
      ? channel.models.find(item => item.model.id === ref.modelId && item.model.version === ref.modelVersion) : undefined;
    if (model && channel?.access === 'allowed') refuseRetiredModelActivation(channel.models, model.modelId, Date.now());
    const registering = registration?.providers.find(item => item.id === ref.providerId && item.version === ref.providerVersion)
      ?.models.find(item => item.id === ref.modelId && item.version === ref.modelVersion);
    return { channel, model, modelId: model?.modelId ?? registering?.nativeId };
  };
  const plannedWorkers = new Map<string, Awaited<ReturnType<typeof workerFacts>>>();
  const key = (reference: ModelReference) => JSON.stringify(reference);
  const probeTarget = async (base: string, nativeId: string) => {
    const candidate = discoveredProviderCatalog(kind, base, nativeId), provider = candidate.providers[0]!, model = provider.models[0]!;
    const reference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
    const known = await workerFacts(reference, null);
    await catalog(provider.id, null);
    await catalog(provider.id, nativeId);
    await chat(reference);
    if (!known.model) await catalog(provider.id, null, 'activate', 'installation');
  };
  const hasOAuth = kind.connect?.adapter === SIWC_INFERENCE.adapter.id;
  const native = kind.connect?.chatPath === null && kind.connect.personOnly && !hasOAuth;
  const mightWithdraw = native && Boolean(kind.connect?.seed) && !command.workspaceId && command.delegate !== undefined;
  const withdrawal = async (plan: Parameters<NonNullable<ModelConnectPorts['beforeAdapter']>>[0],
    layers: Awaited<ReturnType<ModelConnectPorts['layers']>>) => {
    if (!mightWithdraw || plan.registrationTargets.length || plan.selections.some(item => item.activate || item.worker)) return false;
    const context = await current();
    const { principalClass, owner } = subscriptionActor(context.principal);
    if (principalClass !== 'person') return false;
    const authored = [layers.global, layers.project].filter(layer => layer['provider_invocation_profiles'] !== undefined);
    let narrowed = false;
    for (const layer of authored) for (const { reference } of plan.selections) {
      const profile = configuredInvocationProfiles(layer).find(row => row.scopeId === scopeId && isDeepStrictEqual(row.reference, reference));
      const definition = nativeCliHeadlessDefinitionSchema.safeParse(profile?.adapter.definition);
      if (!definition.success || !definition.data.sourceBinding
        || command.cli?.configDir !== undefined && command.cli.configDir !== definition.data.configDir
        || command.cli?.executable !== undefined && command.cli.executable !== definition.data.executable) return false;
      const consent = delegatedUseConsentSchema.safeParse(definition.data.delegatedUse);
      const classes = consent.success && isDeepStrictEqual(consent.data.consentedBy, owner) ? consent.data.classes : [];
      if (!command.delegate!.every(value => classes.includes(value))) return false;
      if (classes.some(value => !command.delegate!.includes(value))) narrowed = true;
    }
    return narrowed;
  };
  const beforeDiscovery = async (base: string | null, layers: Awaited<ReturnType<ModelConnectPorts['layers']>>, host: ModelDiscoveryHost) => {
    const listed = 'pull' in command.model && Boolean(kind.probe?.listsModels);
    const discovery = hasOAuth || Boolean(command.workspaceId) || listed || !kind.connect!.seed && 'nativeId' in command.model;
    const custody = kind.connect!.chatPath === null && (!kind.connect!.catalogOnly || kind.connect!.headless);
    if (mightWithdraw && command.delegate?.length === 0 && subscriptionActor((await current()).principal).principalClass !== 'person')
      throw ErrorRegistry.createError('HEADLESS_PERSON_REQUIRED');
    if (!discovery && (!custody || mightWithdraw)) return;
    await discoveryAuthority(base, layers, host, discovery);
  };
  const discoveryAuthority = async (base: string | null, layers: Awaited<ReturnType<ModelConnectPorts['layers']>>, host: ModelDiscoveryHost, discovery: boolean) => {
    await witness();
    const channelId = 'reference' in command.model ? command.model.reference.providerId : channelFor(base);
    await catalog(channelId, null);
    if (discovery) await catalog(channelFor(base), null, 'inspect');
    if ('reference' in command.model) await chat(command.model.reference);
    if (hasOAuth) await authorizeSiwcConnect(await current(), scopeId, command.subscription?.connectionId);
    if (!kind.connect!.seed && 'nativeId' in command.model) await probeTarget(base ?? '', command.model.nativeId);
    const { global, project } = layers, profileLayers = global['provider_invocation_profiles'] === undefined ? ['project'] as const
      : project['provider_invocation_profiles'] === undefined ? ['global'] as const : ['global', 'project'] as const;
    await config([...profileLayers.map(layer => ({ layer, keyPath: 'provider_invocation_profiles' })),
      ...('reference' in command.model ? [] : [{ layer: project['provider_catalog'] !== undefined || global['provider_catalog'] === undefined ? 'project' as const : 'global' as const, keyPath: 'provider_catalog' }])]);
    if (command.workspaceId) {
      const rows = await listConfiguredConnectionWorkspaces(root, scopeId, kind.id, base, options, host);
      if (!rows.some(row => row.id === command.workspaceId)) throw ErrorRegistry.createError('MODEL_CONNECT_MODEL_UNKNOWN');
    }
  };
  const targets: NonNullable<ModelConnectPorts['beforeAdapter']> = async plan => {
    for (const target of plan.registrationTargets)
      await catalog(target.channelId, target.modelId, 'activate', 'installation');
    for (const item of plan.selections) {
      if (plan.profiled) await chat(item.reference);
      const worker = await workerFacts(item.reference, null), expected = plannedWorkers.get(key(item.reference));
      if (expected && (!isDeepStrictEqual(expected.channel, worker.channel) || !isDeepStrictEqual(expected.model, worker.model))) throw ErrorRegistry.createError('MODEL_CATALOG_REVISION_CONFLICT');
      const modelId = worker.modelId ?? expected?.modelId;
      if (modelId === undefined) continue;
      await catalog(item.reference.providerId, null);
      await catalog(item.reference.providerId, modelId);
      if (item.worker && worker.channel?.access === 'allowed' && worker.channel.activation?.state !== 'active') {
        const now = Date.now();
        for (const entry of worker.channel.models) if (entry.activation?.state === 'active' && !isRetiredCatalogModel(entry, now)) {
          await catalog(item.reference.providerId, entry.modelId);
        }
      }
    }
  };
  const writtenChannels = new Map<string, { state: 'active'; revision: number }>();
  return { current, witness, beforeDiscovery, mightWithdraw, withdrawal, discoveryAuthority, targets, authorizeCarry: chat, config,
    async applyWorker(reference: ModelReference, write: () => Promise<boolean>) {
      const expected = plannedWorkers.get(key(reference)), actual = await workerFacts(reference, null);
      const sameModel = expected?.model ? expected.model.revision === actual.model?.revision && isDeepStrictEqual(expected.model.activation, actual.model?.activation)
        : actual.model?.activation === null && expected?.modelId === actual.model?.modelId;
      const parent = writtenChannels.get(reference.providerId) ?? (expected?.channel?.access === 'allowed' ? expected.channel.activation : null);
      if (!sameModel || actual.channel?.access !== 'allowed' || !isDeepStrictEqual(parent, actual.channel.activation))
        throw ErrorRegistry.createError('MODEL_CATALOG_REVISION_CONFLICT');
      const result = await write();
      if (result && parent?.state !== 'active') writtenChannels.set(reference.providerId, { state: 'active', revision: (parent?.revision ?? 0) + 1 });
      return result;
    },
    async beforeProbes(base: string, ids: readonly string[]) { for (const id of ids) await probeTarget(base, id); },
    async workerNeeded(reference: ModelReference, registering: ProviderCatalogDocument | null) {
      const facts = await workerFacts(reference, registering);
      plannedWorkers.set(key(reference), facts);
      const { channel, model, modelId } = facts;
      return modelId !== undefined && (channel?.access !== 'allowed' || channel.activation?.state !== 'active' || model?.activation?.state !== 'active');
    },
  };
}
