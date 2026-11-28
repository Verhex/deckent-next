import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { modelConnectCommandSchema, type ModelConnectResult } from '#domain/index.js';
import { isDeepStrictEqual } from 'node:util';
import { configuredInvocationProfiles, OAuthConnectionError, ModelConnectApplication, ModelConnectError, workerConnectionModelIds, assessModelInvocationProfileDeliveries, configServiceState, planProfileCache, type DescribeService, type ProfileCachePlan, planProfileChanges, type ProfileChangePlan, ModelActivationStoreError, refuseRetiredModelActivation } from '#engine/index.js';
import { SIWC_INFERENCE, providerSpendingConfiguredBudget, PROVIDER_CONNECT_REGISTRY, ProviderConnectError, connectionAdapter, providerConnectSecretName, providerConnectModelPriced, discoveredProviderCatalog, probeLocalToolCalls, providerEndpoint, providerProfileCacheOffer, readProviderConnectSeed, type ProviderConnectRegistry, providerProfileProtocolOffer, type ProviderProfileProtocolDetail } from '#adapters/index.js';
import { DeckentError, ErrorRegistry, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { configuredLayersShareFile, createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';
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
/** Code-only host ports: secret names, service status and a validated registry overlay; never config/env. */
export type ModelConnectHost = ModelDiscoveryHost & Readonly<{ siwcPresentation?: import('#composition/core/siwc/index.js').SiwcBrowserPresentation; registry?: ProviderConnectRegistry; listSecretNames?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ names: readonly string[] }>>; describeService?: DescribeService }>;
/** Shared model-connect composition over existing config/catalog/activation/audit owners. Seedless discovery keeps credentials in its adapter. */
export async function connectConfiguredModel(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}, host: ModelConnectHost = {}): Promise<ModelConnectResult> {
  let siwc: ReturnType<typeof configuredSiwcConnect> | null = null;
  let enablingWriteStarted = false;
  let connectPhase: 'before-profile-write' | 'profile-write-started' | 'profile-written' = 'before-profile-write';
  try {
    const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, command = modelConnectCommandSchema.safeParse(input).data;
    const kind = registry.kinds.find(row => row.id === command?.connection), scopeId = command?.scopeId ?? '';
    let observed: Awaited<ReturnType<typeof snapshotConfiguredConfig>> | null = null, globalDigest: string | null = null;
    let own: { layer: 'global' | 'project'; digest: string } | null = null;
    const oneFile = configuredLayersShareFile(projectRoot, options);
    const sameLayers = (snapshot: NonNullable<typeof observed>) => {
      if (observed && (!isDeepStrictEqual(observed.global, snapshot.global) || !isDeepStrictEqual(observed.project, snapshot.project)))
        throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    };
    const config = createConfiguredConfigApplication(projectRoot, options, sameLayers);
    const authority = command && kind ? connectAuthority(projectRoot, command, options, kind) : null;
    const scope = (access: 'read' | 'write') => loadConfiguredScopeContext(projectRoot, scopeId, options, access);
    const principal = async () => (await authority!.current()).principal;
    let withdrawing = false;
    const cli = command && kind?.connect?.chatPath === null && kind.connect.adapter !== SIWC_INFERENCE.adapter.id
      && (!kind.connect.catalogOnly || kind.connect.headless) ? headlessConnectPorts(command, options, access => access === 'read' ? authority!.current() : scope(access)) : null;
    // As at the base, only a person-only CLI connection reads the activation without its model use (a legacy profile is repaired there);
    // every other kind keeps the model-use check of the existing profile (R6). The person-only observer uses the snapshot's scope context.
    const facts = kind?.connect?.personOnly && kind.connect.chatPath === null ? { modelUse: false } as const : {};
    // As at the base, the listing behind `catalogHas` and `registered` reads with the same rule: for an ordinary kind each declared catalog
    // model's chat state, with its inspect and model-use checks (R6). Each logical read is fresh, as at the base; only calls of one batch that
    // run at the same time share the listing in flight. The worker comparisons keep the plain cached view.
    const listings = new Map<string, Promise<Awaited<ReturnType<typeof inspectConfiguredModelCatalog>>['channels'][number] | undefined>>();
    const listed = (channelId: string) => listings.get(channelId) ?? listings.set(channelId, inspectConfiguredModelCatalog(projectRoot,
      { schemaVersion: 1, scopeId, channelId }, options, facts).then(result => result.channels[0]).finally(() => listings.delete(channelId))).get(channelId)!;
    const activationContext = { context: async () => authority!.initial() } as Parameters<typeof inspectConfiguredModelActivation>[4];
    if (command && kind?.connect?.adapter === SIWC_INFERENCE.adapter.id) siwc = configuredSiwcConnect(projectRoot, command, options, host.siwcPresentation);
    const siwcModels = async () => (await siwc!.models()).map(row => row.slug);
    let pulled: readonly string[] | null = null;
    const checkLayers = async () => sameLayers(await snapshotConfiguredConfig(projectRoot, options));
    const app = new ModelConnectApplication({
      kind: id => kind?.id === id ? { ...kind, keyRequired: kind.key?.required ?? false } : null,
      defaults: registry.profileDefaults,
      async available(id, base) {
        if (kind!.connect?.catalogOnly) {
          const seed = await readProviderConnectSeed(kind!.connect.seed!), ids = workerConnectionModelIds(seed, observed!.effective);
          if (ids.length || kind!.connect.headless) return ids;
          throw ErrorRegistry.createError('MODEL_CONNECT_WORKER_IMAGE_REQUIRED', { params: { cli: seed.providers[0]?.channel.cli ?? id } });
        }
        if (siwc) return pulled = await siwcModels();
        return kind!.probe?.listsModels ? pulled = (await listConfiguredConnectionModels(projectRoot, scopeId, id, base, options, host)).map(row => row.nativeId) : null;
      },
      priced: (_id, nativeId, base) => providerConnectModelPriced(kind!, nativeId, base),
      async beforeDiscovery(command, _kind, base, layers) {
        await authority!.beforeDiscovery(base, layers, host);
        if (command.workspaceId) host = { ...host, discoveryOptions: { ...host.discoveryOptions, workspaceId: command.workspaceId } };
      },
      beforeProbes: (_kind, base, ids, layers) => authority!.beforeProbes(base, ids, layers),
      async beforeAdapter(plan) {
        if (!cli && !siwc) return;
        if (authority!.mightWithdraw || authority!.mightObserve) {
          const layers = observed!;
          withdrawing = await authority!.withdrawal(plan, layers);
          if (withdrawing) return;
          await authority!.discoveryAuthority(null, layers, host, false);
        }
        const context = await authority!.current();
        authority!.config(context, plan.writes);
        await authority!.targets(plan, context);
      },
      async authorizePlan(plan) {
        withdrawing &&= plan.delegationOnly;
        const [context] = await Promise.all([authority!.current(), checkLayers()]);
        if (!withdrawing) { await authority!.targets(plan, context, plan.observation); authority!.config(context, plan.writes); }
      },
      async authorizeCarry(reference, binding) {
        await authority!.authorizeCarry(reference);
        const { config } = authority!.initial();
        const targets = configuredInvocationProfiles(config).filter(profile => profile.scopeId === scopeId && isDeepStrictEqual(profile.reference, reference))
          .map(profile => ({ profile, definition: binding.definition, catalogRevision: binding.catalogRevision }));
        const finding = assessModelInvocationProfileDeliveries(targets, configuredModelInvocationDeliverySurfaces(config))[0];
        if (finding) throw new ModelActivationStoreError('MODEL_ACTIVATION_DELIVERY_UNFIT', finding);
      },
      workerNeeded: (reference, registration) => authority!.workerNeeded(reference, registration),
      ...(cli ? { commitAdapter: cli.commit, observeAdapter: (nativeId, existing) => cli.observe(kind!, nativeId, existing) } : {}),
      async beforeWrite() {
        const [context] = await Promise.all([authority!.current(), checkLayers()]);
        if (!withdrawing) await authority!.attest(context, !enablingWriteStarted);
        enablingWriteStarted = true;
      },
      endpoint: text => { const checked = providerEndpoint(text); return checked.ok ? checked.base : null; },
      secretName: (_id, base) => providerConnectSecretName(kind!, base),
      seed: readProviderConnectSeed,
      discover: async (id, base, nativeId) => {
        if (siwc && !pulled) pulled = await siwcModels();
        return pulled?.includes(nativeId) ? discoveredProviderCatalog(kind!, base, nativeId, await probeLocalToolCalls(kind!, base, nativeId, host.discoveryOptions))
          : discoverConfiguredConnectionModel(projectRoot, scopeId, id, base, nativeId, options, host);
      },
      adapter: (_id, value) => siwc ? siwc.adapter(value.existing) : cli ? cli.adapter(kind!, value) : connectionAdapter(kind!, { ...value, endpoint: value.endpoint ?? '' }),
      workerActivate: (reference, commandId, beforeWrite) => authority!.applyWorker(reference,
        planned => activateConfiguredWorkerModel(projectRoot, scopeId, reference, commandId, options, beforeWrite, planned)),
      async authorizeDelegation() { await authority!.witness(); },
      principal,
      async layers() {
        const snapshot = await snapshotConfiguredConfig(projectRoot, options), written = own, hold = () => ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
        own = null;
        // A re-read advances the expected state only by this connect's own verified write: the published layer's own read has its digest (the
        // global one below), and any other change stops it. When both read layers are one file, the other view is that same written file.
        // Under `globalOnly` the project layer is not read, so a project write is checked against the published file's own digest.
        const shared = written !== null && oneFile, published = written?.layer === 'project' && options.globalOnly
          ? (await snapshotConfiguredConfig(projectRoot, { ...options, globalOnly: false })).digest : snapshot.digest;
        if (observed && ((['global', 'project'] as const).some(layer => layer !== written?.layer && !shared && !isDeepStrictEqual(observed![layer], snapshot[layer]))
          || written?.layer === 'project' && published !== written.digest)) throw hold();
        observed = snapshot;
        if (written?.layer === 'global' || snapshot.global['provider_catalog'] !== undefined || snapshot.global['provider_invocation_profiles'] !== undefined) {
          const global = await snapshotConfiguredConfig(projectRoot, options, 'global');
          if (written?.layer === 'global' && global.digest !== written.digest) throw hold();
          sameLayers(global); globalDigest = global.digest;
        }
        return snapshot;
      },
      async write({ capabilityProfile: profile, ...change }) {
        const input = { ...change, expect: change.layer === 'global' ? globalDigest : observed!.digest, principal: authority!.initial().principal, scopeId: scopeId };
        const base = command!.endpoint ?? kind!.endpoint.default;
        const target = profile ? connectionAdapter(kind!, { endpoint: `${base}${kind!.connect!.chatPath}`, credentialRef: providerConnectSecretName(kind!, base),
          nativeId: 'nativeId' in command!.model ? command!.model.nativeId : profile.reference.modelId, maxOutputTokens: registry.profileDefaults.maxOutputTokens,
          currency: registry.profileDefaults.currency, existing: profile.adapter.definition }) : null;
        // submit can reject after publication (e.g. backup pruning); a rejection alone proves no rollback.
        if (change.keyPath === 'provider_invocation_profiles') connectPhase = 'profile-write-started';
        const outcome = target && profile ? await config.submitCatalogCapabilities(input, { reference: profile.reference, adapter: target.adapter, protocol: target.protocol })
          : await config.submit('set', input);
        if (outcome.status === 'applied') own = { layer: change.layer, digest: outcome.result.afterDigest };
        if (change.keyPath === 'provider_invocation_profiles' && outcome.status === 'applied') connectPhase = 'profile-written';
        if (outcome.status === 'approval-pending') return { approvalId: outcome.approval.approvalId, keyPath: outcome.keyPath };
        const rebound = target && profile ? await inspectModelBinding(projectRoot, profile.reference, options) : null;
        return rebound?.status === 'declared' && profile && rebound.binding.digest !== profile.bindingDigest ? { reboundProfile: profile.reference } : null;
      },
      async catalogHas(channelId, nativeId) {
        const row = await listed(channelId);
        return row?.access === 'allowed' && row.models.some(entry => entry.model.nativeId === nativeId);
      },
      async registered(channelId, nativeId) {
        const channel = await listed(channelId);
        if (channel?.access !== 'allowed') return null;
        const entry = channel.models.find(item => item.model.nativeId === nativeId);
        if (entry) refuseRetiredModelActivation(channel.models, entry.modelId, Date.now());
        return entry ? { providerVersion: channel.providerVersion, modelRevision: entry.revision, model: entry.model } : null;
      },
      async register(catalog, commandId) { await applyConfiguredModelCatalog(projectRoot, { schemaVersion: 1, commandId, scopeId, action: 'register', catalog }, options); },
      binding: reference => inspectModelBinding(projectRoot, reference, options),
      async activation(reference, fresh) {
        return (await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: scopeId, reference }, options, facts, fresh || !('modelUse' in facts) ? undefined : activationContext)).activation;
      },
      async activate(value) {
        await carryConfiguredModelActivation(projectRoot, { schemaVersion: 1, action: 'activate', commandId: value.commandId, scopeId: scopeId, reference: value.reference,
          expectedRevision: value.expectedRevision, catalogRevision: value.catalogRevision, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: value.digest } }, options);
      },
      delivers: (profile, binding, spare) => assessModelInvocationProfileDeliveries([{ profile: profile as never, definition: binding.definition, catalogRevision: binding.catalogRevision }],
        configuredModelInvocationDeliverySurfaces(observed!.effective as never).map(([surface, frame]) => [surface, { maxResultBytes: frame.maxResultBytes - spare }] as const)).length === 0,
      async audit(event) { await withScopeAudit(await scope('write'), audit => { audit.record(event); }); },
      async policyRevision() { return authority!.initial().document.revision; },
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
    // "Connected" from the chosen session in memory, as at HEAD, but not when the OAuth owner itself refused (a failed renewal or lease after the
    // account was chosen can leave the stored connection revoked or unknown). Nothing is read or written to explain the refusal.
    const oauthConnected = siwc?.connected() === true && !(error instanceof OAuthConnectionError);
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
  } catch (error) { return { state: 'unknown', code: error instanceof DeckentError ? error.code : 'QUERY_UNEXPECTED_FAILURE' }; }
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
