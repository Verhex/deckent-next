import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { configuredContinuationPin, prepareConfiguredSiwcContinuation } from './continuation.js';
import { isDeepStrictEqual } from 'node:util';
import { t, SystemTrustedClock, type ConfigLoadOptions, type TrustedClock } from '#platform/index.js';
import { configuredModelInvocationDeliverySurfaces } from './delivery-audit.js';
import { randomUUID } from 'node:crypto';
import { ModelInvocationError, modelInvocationCommandInputSchema, type ModelInvocationCommand, type ModelInvocationDeltaSink } from '#domain/index.js';
import { configuredInvocationProfiles, verifiedPrincipal, ModelInvocationApplication, ModelInvocationPolicyAuthorization, ModelBindingApplication, ModelActivationApplication, ModelActivationPolicyAuthorization, assessModelInvocationProfileDeliveries, type ModelInvocationControllers, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, openSqliteModelActivationReader, openSqliteModelActivationStore, type LocalPeerIdentity } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';
import { createConfiguredModelInvocationNative, type ModelInvocationNativeBinding } from './native.js';
import { modelSpendRefusal } from './spend-refusal.js';
type InvocationGuard = { profile(profile: import('#domain/index.js').ModelInvocationProfile): Promise<void>; spending(value: import('#engine/index.js').ModelInvocationSpending): void };
type ApplicationOptions = {
  context: Awaited<ReturnType<typeof loadInvocationContext>>; options: ConfigLoadOptions; host?: RuntimeModelInvocationHost | undefined;
  snapshot?: ModelInspectionSnapshot; readOnly?: boolean; entry?: 'raw' | 'feature'; profileGuard?: InvocationGuard['profile'] | undefined;
  observeSpending?: InvocationGuard['spending'] | undefined; agent?: ModelInvocationNativeBinding | undefined;
};
type InvokeOptions = {
  input: ModelInvocationCommand; loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>; options: ConfigLoadOptions;
  signal?: AbortSignal | undefined; delivery?: ModelInvocationDelivery | undefined; host?: RuntimeModelInvocationHost | undefined;
  onDelta?: ModelInvocationDeltaSink | undefined; entry?: 'raw' | 'feature'; onNotice?: ((text: string) => void | Promise<void>) | undefined;
  guard?: InvocationGuard | undefined; agent?: ModelInvocationNativeBinding | undefined;
};
export interface RuntimeModelInvocationHost { readonly ownerId: string; readonly controllers: ModelInvocationControllers; readonly clock?: TrustedClock }
/** A direct local invocation. A claimed operation is never sent again by receipt replay. */
export async function invokeConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal, delivery?: ModelInvocationDelivery) { return invoke({ input, loadContext: scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, delivery }); }
/** S4B-3: a composition-root workload (the memory evaluator) invokes under its own verified principal and grants (V5); no client channel reaches it. */
export async function invokeConfiguredModelAs(projectRoot: string, input: ModelInvocationCommand, principal: Awaited<ReturnType<typeof loadInvocationContext>>['principal'], options: ConfigLoadOptions = {}, signal?: AbortSignal,
  guard?: { profile(profile: import('#domain/index.js').ModelInvocationProfile): Promise<void>; spending(value: import('#engine/index.js').ModelInvocationSpending): void }) {
  return invoke({ input, loadContext: async scopeId => Object.freeze({ ...await loadInvocationContext(projectRoot, scopeId, options, 'write'), principal }), options, signal, entry: 'feature', guard });
}
/** Code-only feature preflight: checked profile, native quote and exact-request provider count, without a model call or claim. */
export async function prepareConfiguredModelAs(projectRoot: string, input: ModelInvocationCommand, principal: Awaited<ReturnType<typeof loadInvocationContext>>['principal'], options: ConfigLoadOptions = {}, signal?: AbortSignal): Promise<{ profile: import('#domain/index.js').ModelInvocationProfile | null; spending: import('#engine/index.js').ModelInvocationSpending | null; measurement: import('#engine/index.js').ModelInvocationMeasurement | null }> {
  const context = Object.freeze({ ...await loadInvocationContext(projectRoot, input.scopeId, options, 'read'), principal });
  let spending: import('#engine/index.js').ModelInvocationSpending | null = null;
  let selected: import('#domain/index.js').ModelInvocationProfile | null = null;
  const app = application({ context, options, readOnly: true, entry: 'feature', profileGuard: async profile => {
    await configuredContinuationPin(input)?.(profile);
    if (selected && !isDeepStrictEqual(selected, profile)) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
    selected = profile;
  }, observeSpending: value => { spending = value; } });
  await app.preview(input, undefined, signal);
  const measurement = await app.measure(input, undefined, signal);
  return { profile: selected, spending, measurement };
}
export async function previewConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}) { try { return await application({ context: await loadInvocationContext(projectRoot, input.scopeId, options, 'read'), options }).preview(input); } catch (error) { throw queryFailure(error); } }
/** Internal runtime wiring only. A missing/invalid peer never falls back to process identity. */
export async function invokePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, signal?: AbortSignal) { return invoke({ input, loadContext: scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, delivery, host, onDelta }); }
export async function invoke({ input, loadContext, options, signal, delivery, host, onDelta, entry = 'raw', onNotice, guard, agent }: InvokeOptions) {
  try {
    const command = parsedCommand(input), context = await loadContext(command.scopeId);
    const forCommand = (value: ModelInvocationCommand) => application({ context, options, host, entry, agent, observeSpending: guard?.spending,
      profileGuard: async profile => { await configuredContinuationPin(value)?.(profile); await guard?.profile(profile); } });
    const app = forCommand(input);
    const result = await app.invoke(command, undefined, signal, delivery, onDelta).catch(error => modelSpendRefusal(context, command.scopeId, error));
    if (agent || entry !== 'feature' || !onDelta || !onNotice) return result;
    const next = await prepareConfiguredSiwcContinuation(context, options, command, result, value => app.preview(value, undefined, signal),
      reference => onNotice(`${t('siwc.switch.notice', { model: reference.modelId }, context.config.language)}\n`), signal);
    return next ? forCommand(next).invoke(next, undefined, signal, delivery, onDelta) : result;
  } catch (error) { throw queryFailure(error); }
}
/** Context measurement of a command (T-L5, runtime-internal): the provider's count of exactly what `invoke` would send, under the same peer principal, policy, binding, activation and profile checks; null when the model or server has no counter. */
export async function measurePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, signal?: AbortSignal, entry: 'raw' | 'feature' = 'raw') {
  return measure(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, entry);
}
/** Direct local measurement shares invocation's principal, policy, binding and activation gates; no model execution or spending. */
export async function measureConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal, entry: 'raw' | 'feature' = 'raw') {
  return measure(input, scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, entry);
}
async function measure(input: ModelInvocationCommand, loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>, options: ConfigLoadOptions, signal: AbortSignal | undefined, entry: 'raw' | 'feature') {
  try {
    const command = parsedCommand(input);
    return await application({ context: await loadContext(command.scopeId), options, entry, profileGuard: configuredContinuationPin(input) }).measure(command, undefined, signal);
  } catch (error) { throw queryFailure(error); }
}
function parsedCommand(input: ModelInvocationCommand) {
  const parsed = modelInvocationCommandInputSchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data as ModelInvocationCommand;
}
export function application({ context, options, host, readOnly = false, entry = 'raw', profileGuard, observeSpending, agent, snapshot }: ApplicationOptions) {
  // One trusted clock for pricing and durable invocation records (I40).
  const clock = host?.clock ?? new SystemTrustedClock(), configuredNative = createConfiguredModelInvocationNative(context, options, clock, readOnly, agent, readOnly ? snapshot : undefined);
  const verifier = verifiedPrincipal(context.principal), bindings = readOnly && snapshot ? snapshot.bindings : new ModelBindingApplication({ async read() { return (await context.freshConfig())['provider_catalog']; } });
  return new ModelInvocationApplication(verifier, new ModelInvocationPolicyAuthorization(context.policy), bindings,
    async () => openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
    { async resolve(scopeId, reference) {
      const profiles = configuredInvocationProfiles(await context.freshConfig());
      const profile = profiles.find(profile => profile.scopeId === scopeId && JSON.stringify(profile.reference) === JSON.stringify(reference)) ?? null;
      if (profile && profileGuard) await profileGuard(profile);
      return profile;
    } },
    configuredNative.natives, async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
    { invocationId: randomUUID, ownerId: () => host?.ownerId ?? randomUUID(), now: () => clock.sample().wallMs, ...(host ? { register: host.controllers.register.bind(host.controllers) } : {}) }, observeSpending ? { ...configuredNative.spending,
      async authorize(input, signal) { const value = await configuredNative.spending.authorize(input, signal); observeSpending(value); return value; } } : configuredNative.spending, async command => {
      const config = await context.freshConfig();
      return new ModelActivationApplication(verifier, new ModelActivationPolicyAuthorization(context.policy), bindings,
        async () => openSqliteModelActivationStore(await context.path(), config.storage.sqlite, 'forbid'), () => clock.sample().wallMs,
        { profiles: { profiles: configuredInvocationProfiles(config) }, surfaces: configuredModelInvocationDeliverySurfaces(config), assess: assessModelInvocationProfileDeliveries }).admit(command);
    }, entry);
}
/** Connected application features only; no wire field selects this path. */
export async function invokeConfiguredFeatureModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return invoke({ input, loadContext: scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, entry: 'feature' });
}
export async function invokePeerConfiguredFeatureModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, signal?: AbortSignal, onNotice?: (text: string) => void | Promise<void>) {
  return invoke({ input, loadContext: scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, delivery, host, onDelta, entry: 'feature', onNotice });
}

/** Brain keeps its explicit source lineage when an authorized billing continuation changes the model reference. */
export async function prepareConfiguredFeatureContinuation(root: string, command: ModelInvocationCommand, result: import('#engine/index.js').ModelInvocationResult,
  options: ConfigLoadOptions, notice: (reference: import('#domain/index.js').ModelReference) => void,
  guard: (next: ModelInvocationCommand) => Promise<unknown>, signal?: AbortSignal): Promise<ModelInvocationCommand | null> {
  const context = await loadInvocationContext(root, command.scopeId, options, 'write'), app = application({ context, options, entry: 'feature' });
  return prepareConfiguredSiwcContinuation(context, options, command, result, async next => { await guard(next); return app.preview(next, undefined, signal); }, notice, signal);
}

/** K11 code-only push invocation: preserves policy, activation, allocation, cancellation and durable model receipts. */
export async function invokePeerConfiguredAgentModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions,
  host: RuntimeModelInvocationHost, onDelta: ModelInvocationDeltaSink, signal: AbortSignal, agent: ModelInvocationNativeBinding) {
  return invoke({ input, loadContext: scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, host, onDelta, entry: 'feature', agent });
}
