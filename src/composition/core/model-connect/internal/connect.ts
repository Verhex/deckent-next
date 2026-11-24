import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { SIWC_INFERENCE } from '#adapters/index.js';
import { modelInvocationProfileSchema, type ModelConnectResult } from '#domain/index.js';
import { isDeepStrictEqual } from 'node:util';
import { configuredInvocationProfiles, OAuthConnectionError, ModelConnectApplication, ModelConnectError, workerConnectionModelIds, assessModelInvocationProfileDeliveries, configServiceState, planProfileCache, type DescribeService, type ProfileCachePlan, planProfileChanges, type ProfileChangePlan, ModelActivationStoreError } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, ProviderConnectError, connectionAdapter, providerConnectSecretName, providerConnectModelPriced, discoveredProviderCatalog, probeLocalToolCalls, providerEndpoint, providerProfileCacheOffer, readProviderConnectSeed, type ProviderConnectRegistry, providerProfileProtocolOffer, type ProviderProfileProtocolDetail } from '#adapters/index.js';
import { DeckentError, ErrorRegistry, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredModelInvocationDeliverySurfaces } from '#composition/core/model-invocation/index.js';
import { activateConfiguredWorkerModel, carryConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { listConfiguredConnectionModels, discoverConfiguredConnectionModel, type ModelDiscoveryHost } from './discovery.js';
import { headlessConnectPorts } from './headless.js';
import { connectAuthority } from './connect-authority.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { providerSpendingConfiguredBudget } from '#adapters/index.js';
import { modelConnectCommandSchema } from '#domain/index.js';
/** Code-only host ports: secret names, service status and a validated registry overlay; never config/env. */
export type ModelConnectHost = ModelDiscoveryHost & Readonly<{ siwcPresentation?: import('#composition/core/siwc/index.js').SiwcBrowserPresentation; registry?: ProviderConnectRegistry; listSecretNames?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ names: readonly string[] }>>; describeService?: DescribeService }>;
/** Shared model-connect composition over existing config/catalog/activation/audit owners. Seedless discovery keeps credentials in its adapter. */
export async function connectConfiguredModel(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}, host: ModelConnectHost = {}): Promise<ModelConnectResult> {
  let siwc: ReturnType<typeof configuredSiwcConnect> | null = null;
  let enablingWriteStarted = false;
  let connectPhase: 'before-profile-write' | 'profile-write-started' | 'profile-written' = 'before-profile-write';
  try {
    const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, scopeId = (input as { scopeId?: unknown } | null)?.scopeId;
    const kindOf = (id: string) => registry.kinds.find(kind => kind.id === id) ?? null;
    let observed: Awaited<ReturnType<typeof snapshotConfiguredConfig>> | null = null, globalDigest: string | null = null;
    const config = createConfiguredConfigApplication(projectRoot, options, snapshot => {
      if (observed && (!isDeepStrictEqual(observed.global, snapshot.global) || !isDeepStrictEqual(observed.project, snapshot.project))) {
        throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      }
    });
    const parsed = modelConnectCommandSchema.safeParse(input), kind = parsed.success ? kindOf(parsed.data.connection) : null;
    const authority = parsed.success && kind ? connectAuthority(projectRoot, parsed.data, options, kind) : null;
    const scope = (access: 'read' | 'write' = 'read') => loadConfiguredScopeContext(projectRoot, String(scopeId), options, access);
    const principal = async () => (await (authority?.current() ?? scope())).principal;
    let effective: Record<string, unknown> = {};
    let withdrawing = false;
    const cli = parsed.success && kind?.connect?.chatPath === null && kind.connect.adapter !== SIWC_INFERENCE.adapter.id
      && (!kind.connect.catalogOnly || kind.connect.headless) ? headlessConnectPorts(parsed.data, options, principal, scope) : null;
    const facts = { modelUse: false } as const;
    const inspectCatalog = (channelId: string) => inspectConfiguredModelCatalog(projectRoot, { schemaVersion: 1, scopeId: String(scopeId), channelId }, options, facts);
    siwc = parsed.success && kindOf(parsed.data.connection)?.connect?.adapter === SIWC_INFERENCE.adapter.id ? configuredSiwcConnect(projectRoot, parsed.data, options, host.siwcPresentation) : null;
    const siwcModels = async () => (await siwc!.models()).map(row => row.slug);
    const pulled = new Map<string, readonly string[]>();
    const checkLayers = async () => {
      const fresh = await snapshotConfiguredConfig(projectRoot, options);
      if (!observed || !isDeepStrictEqual(observed.global, fresh.global) || !isDeepStrictEqual(observed.project, fresh.project))
        throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    };
    const app = new ModelConnectApplication({
      kind: id => { const kind = kindOf(id); return kind && { id: kind.id, available: kind.available, endpoint: kind.endpoint, keyRequired: kind.key?.required ?? false, connect: kind.connect }; },
      defaults: registry.profileDefaults,
      async available(id, base) {
        const kind = kindOf(id)!;
        if (kind.connect?.catalogOnly) { const seed = await readProviderConnectSeed(kind.connect.seed!), ids = workerConnectionModelIds(seed, effective as never); if (ids.length || kind.connect.headless) return ids; throw ErrorRegistry.createError('MODEL_CONNECT_WORKER_IMAGE_REQUIRED', { params: { cli: seed.providers[0]?.channel.cli ?? kind.id } }); } // BeUser M-24: the image comes first (owner 2026-10-31: for a headless kind it gates only the worker activation)
        if (kind.connect?.adapter === SIWC_INFERENCE.adapter.id && siwc) { const ids = await siwcModels(); pulled.set(id, ids); return ids; }
        if (!kind.probe?.listsModels) return null;
        const ids = (await listConfiguredConnectionModels(projectRoot, String(scopeId), id, base, options, host)).map(row => row.nativeId);
        pulled.set(id, ids); return ids;
      },
      priced: (id, nativeId, base) => providerConnectModelPriced(kindOf(id)!, nativeId, base),
      async beforeDiscovery(command, _kind, base, layers) {
        await authority!.beforeDiscovery(base, layers, host);
        if (command.workspaceId) host = { ...host, discoveryOptions: { ...host.discoveryOptions, workspaceId: command.workspaceId } };
      },
      async beforeProbes(_kind, base, ids) { await authority!.beforeProbes(base, ids); },
      async beforeAdapter(plan) {
        if (authority!.mightWithdraw) {
          const layers = { global: observed!.global, project: observed!.project, effective };
          withdrawing = await authority!.withdrawal(plan, layers);
          if (withdrawing) return;
          await authority!.discoveryAuthority(null, layers, host, false);
        }
        await authority!.targets(plan);
      },
      async authorizePlan(plan) {
        withdrawing &&= plan.delegationOnly;
        if (!withdrawing) {
          await authority!.targets(plan);
          await authority!.config(plan.writes);
        }
        await checkLayers();
      },
      async authorizeCarry(reference, binding) {
        await authority!.authorizeCarry(reference);
        const context = await authority!.current();
        const targets = configuredInvocationProfiles(context.config).map(profile => modelInvocationProfileSchema.parse(profile))
          .filter(profile => profile.scopeId === scopeId && isDeepStrictEqual(profile.reference, reference))
          .map(profile => ({ profile, definition: binding.definition, catalogRevision: binding.catalogRevision }));
        const finding = assessModelInvocationProfileDeliveries(targets, configuredModelInvocationDeliverySurfaces(context.config))[0];
        if (finding) throw new ModelActivationStoreError('MODEL_ACTIVATION_DELIVERY_UNFIT', finding);
      },
      workerNeeded: (reference, registration) => authority!.workerNeeded(reference, registration),
      ...(cli ? { commitAdapter: () => cli.commit() } : {}),
      async beforeWrite() {
        await checkLayers();
        if (!withdrawing) await authority!.witness(!enablingWriteStarted);
        enablingWriteStarted = true;
      },
      endpoint: text => { const checked = providerEndpoint(text); return checked.ok ? checked.base : null; },
      secretName: (id, base) => { const kind = kindOf(id); return kind ? providerConnectSecretName(kind, base) : null; },
      seed: readProviderConnectSeed,
      discover: async (id, base, nativeId) => {
        if (kindOf(id)?.connect?.adapter === SIWC_INFERENCE.adapter.id && siwc && !pulled.has(id)) pulled.set(id, await siwcModels());
        return pulled.get(id)?.includes(nativeId) ? discoveredProviderCatalog(kindOf(id)!, base, nativeId, await probeLocalToolCalls(kindOf(id)!, base, nativeId, host.discoveryOptions)) : discoverConfiguredConnectionModel(projectRoot, String(scopeId), id, base, nativeId, options, host);
      },
      adapter: async (id, value) => kindOf(id)?.connect?.adapter === SIWC_INFERENCE.adapter.id && siwc ? siwc.adapter(value.existing) : kindOf(id)?.connect?.chatPath === null && cli ? cli.adapter(kindOf(id)!, value) : connectionAdapter(kindOf(id)!, { ...value, endpoint: value.endpoint ?? '' }),
      workerActivate: (reference, commandId) => authority!.applyWorker(reference,
        () => activateConfiguredWorkerModel(projectRoot, String(scopeId), reference, commandId, options)),
      authorizeDelegation: () => authority!.witness(),
      principal,
      async layers() {
        const [snapshot, global] = await Promise.all([snapshotConfiguredConfig(projectRoot, options), snapshotConfiguredConfig(projectRoot, options, 'global')]);
        if (!isDeepStrictEqual(snapshot.global, global.global) || !isDeepStrictEqual(snapshot.project, global.project)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
        observed = snapshot; globalDigest = global.digest; effective = snapshot.effective as never;
        return { global: snapshot.global, project: snapshot.project, effective };
      },
      async write(change) {
        const input = { ...change, expect: change.layer === 'global' ? globalDigest : observed!.digest, principal: await principal(), scopeId: String(scopeId) };
        const kind = parsed.success ? kindOf(parsed.data.connection) : null;
        const profiles = configuredInvocationProfiles(observed?.[change.layer] ?? {});
        const selected = parsed.success && 'nativeId' in parsed.data.model ? parsed.data.model.nativeId : null;
        const profile = profiles.find(profile => profile.scopeId === scopeId && (parsed.success && 'reference' in parsed.data.model
          ? isDeepStrictEqual(profile.reference, parsed.data.model.reference)
          : (effective['provider_catalog'] as import('#domain/index.js').ProviderCatalog | undefined)?.providers
            .find(row => row.id === profile.reference.providerId && row.version === profile.reference.providerVersion)?.models
            .some(row => row.id === profile.reference.modelId && row.version === profile.reference.modelVersion && row.nativeId === selected)));
        const target = change.keyPath === 'provider_catalog' && kind?.connect && !kind.connect.seed && profile && parsed.success
          ? connectionAdapter(kind, { endpoint: `${parsed.data.endpoint ?? kind.endpoint.default}${kind.connect.chatPath}`, credentialRef: providerConnectSecretName(kind, parsed.data.endpoint ?? kind.endpoint.default),
            nativeId: selected ?? profile.reference.modelId, maxOutputTokens: registry.profileDefaults.maxOutputTokens, currency: registry.profileDefaults.currency, existing: profile.adapter.definition }) : null;
        // submit can reject after publication (e.g. backup pruning); a rejection alone proves no rollback.
        if (change.keyPath === 'provider_invocation_profiles') connectPhase = 'profile-write-started';
        const outcome = target && profile ? await config.submitCatalogCapabilities(input, { reference: profile.reference, adapter: target.adapter, protocol: target.protocol })
          : await config.submit('set', input);
        if (change.keyPath === 'provider_invocation_profiles' && outcome.status === 'applied') connectPhase = 'profile-written';
        if (outcome.status === 'approval-pending') return { approvalId: outcome.approval.approvalId, keyPath: outcome.keyPath };
        const rebound = target && profile ? await inspectModelBinding(projectRoot, profile.reference, options) : null;
        return rebound?.status === 'declared' && profile && rebound.binding.digest !== profile.bindingDigest ? { reboundProfile: profile.reference } : null;
      },
      async catalogHas(channelId, nativeId) {
        const listed = await inspectCatalog(channelId);
        return listed.channels.some(channel => channel.channelId === channelId && channel.access !== 'denied' && channel.models.some(entry => entry.model.nativeId === nativeId));
      },
      async registered(channelId, nativeId) {
        const listed = await inspectCatalog(channelId);
        for (const channel of listed.channels) {
          if (channel.channelId !== channelId || channel.access !== 'allowed') continue;
          const entry = channel.models.find(item => item.model.nativeId === nativeId);
          if (entry) return { providerVersion: channel.providerVersion, modelRevision: entry.revision, model: entry.model };
        }
        return null;
      },
      async register(catalog, commandId) { await applyConfiguredModelCatalog(projectRoot, { schemaVersion: 1, commandId, scopeId, action: 'register', catalog }, options); },
      binding: reference => inspectModelBinding(projectRoot, reference, options),
      async activation(reference) { return (await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: String(scopeId), reference }, options, facts)).activation; },
      async activate(value) {
        await carryConfiguredModelActivation(projectRoot, { schemaVersion: 1, action: 'activate', commandId: value.commandId, scopeId: String(scopeId), reference: value.reference,
          expectedRevision: value.expectedRevision, catalogRevision: value.catalogRevision, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: value.digest } }, options);
      },
      delivers: (profile, binding, spare) => assessModelInvocationProfileDeliveries([{ profile: profile as never, definition: binding.definition, catalogRevision: binding.catalogRevision }],
        configuredModelInvocationDeliverySurfaces(effective as never).map(([surface, frame]) => [surface, { maxResultBytes: frame.maxResultBytes - spare }] as const)).length === 0,
      async audit(event) { await withScopeAudit(await scope('write'), audit => { audit.record(event); }); },
      async policyRevision() { return (await scope()).document.revision; },
      async keyStored(name) { if (!host.listSecretNames) return null; try { return (await host.listSecretNames(projectRoot, options)).names.includes(name); } catch { return null; } },
      service: () => configServiceState(projectRoot, options, host.describeService),
    });
    const result = await app.connect(input);
    return result.status === 'connected' && result.tariff === 'published' ? Object.freeze({ ...result, budget: await connectBudget(projectRoot, result.scopeId, options) }) : result;
  } catch (error) { const wanted = (input as { model?: { nativeId?: unknown; reference?: { modelId?: unknown } } } | null)?.model, requested = wanted?.nativeId ?? wanted?.reference?.modelId;
    let normalized: unknown = error;
    if (error instanceof OAuthConnectionError) normalized = ErrorRegistry.createError(error.code, { params: error.reason ? { reason: error.reason } : {} });
    if (error instanceof ModelConnectError) normalized = ErrorRegistry.createError(error.code, { params: { models: (error.models ?? []).map(model => model.nativeId.replace(/[\p{Cc}\p{Cf}]/gu, '?')).join(', '), ...error.code === 'MODEL_CONNECT_MODEL_UNKNOWN' && typeof requested === 'string' ? { model: requested.slice(0, 200).replace(/[\p{Cc}\p{Cf}]/gu, '?'), connection: String((input as { connection?: unknown } | null)?.connection ?? '-').slice(0, 200).replace(/[\p{Cc}\p{Cf}]/gu, '?') } : {} } }); // KER-07
    if (error instanceof ProviderConnectError) normalized = ErrorRegistry.createError(error.code);
    const failure = normalized instanceof DeckentError ? normalized : queryFailure(normalized);
    const oauthConnected = siwc?.connected() === true;
    const localizeRefusal = oauthConnected ? (locale: Locale) => {
      if (failure.code === 'AUTHORITY_WITNESS_REQUIRED' && !enablingWriteStarted)
        return { ...failure.localize?.(locale), message: t('siwc.connectedActivationRefused', {}, locale) };
      const cause = failure.localize?.(locale);
      const params = { reason: cause?.message ?? failure.message };
      return { ...cause, message: enablingWriteStarted ? t('siwc.connectedActivationUnconfirmed', params, locale)
        : t('siwc.connectedActivationFailed', params, locale) };
    } : undefined;
    throw new DeckentError(failure.code, localizeRefusal?.('en').message ?? failure.message, failure.suggestion, failure.docLink, failure.whatHappened, failure.why, failure.howToFix,
      failure.category, { cause: failure }, localizeRefusal ?? failure.localize, Object.freeze({ ...failure.params, connectPhase,
        ...(oauthConnected ? { connectionState: 'connected', activationState: 'unfinished' } : {}) }));
  }
}
/** İ-12 budget step: the priced-turn gate's own rule (`model-invocation/internal/native.ts` budgetFor — the scope's account, else a configured budget). */
async function connectBudget(projectRoot: string, scopeId: string, options: ConfigLoadOptions): Promise<NonNullable<ModelConnectResult['budget']>> {
  try {
    const config = await loadComposedConfig(projectRoot, options), account = await inspectConfiguredProviderSpendAccount(projectRoot, { schemaVersion: 1, scopeId, current: true }, options);
    return { state: account.checkpoint || providerSpendingConfiguredBudget(config, scopeId) ? 'present' : 'missing' };
  }
  catch (error) { return { state: 'unknown', code: error instanceof DeckentError ? error.code : 'QUERY_UNEXPECTED_FAILURE' }; }
}
/** Read-only cache preview; every resulting change goes through the governed config writer. */
export async function planConfiguredProfileCache(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<ProfileCachePlan> {
  const snapshot = await snapshotConfiguredConfig(projectRoot, options);
  return planProfileCache({ global: snapshot.global as Record<string, unknown>, project: snapshot.project as Record<string, unknown> }, scopeId, providerProfileCacheOffer);
}
type ProfileProtocolPlan = Omit<ProfileChangePlan<ProviderProfileProtocolDetail>, 'writes'> & Readonly<{ writes: readonly Readonly<{ layer: 'global' | 'project'; value: Record<string, unknown>; expect: string | null }>[] }>;
export async function planConfiguredProfileProtocol(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<ProfileProtocolPlan> {
  const snapshots = await Promise.allSettled(['global', 'project'].map(layer => snapshotConfiguredConfig(projectRoot, options, layer as 'global' | 'project')));
  for (const snapshot of snapshots) if (snapshot.status === 'rejected') throw snapshot.reason;
  const global = (snapshots[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof snapshotConfiguredConfig>>>).value;
  const project = (snapshots[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof snapshotConfiguredConfig>>>).value;
  if (!isDeepStrictEqual(global.global, project.global) || !isDeepStrictEqual(global.project, project.project)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
  const plan = planProfileChanges({ global: global.global, project: project.project }, scopeId, providerProfileProtocolOffer);
  return { ...plan, writes: plan.writes.map(write => ({ ...write, expect: (write.layer === 'global' ? global : project).digest })) };
}
