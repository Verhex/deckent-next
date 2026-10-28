import { configuredContinuationPin, prepareConfiguredSiwcContinuation } from './continuation.js';
import { t, SystemTrustedClock, type ConfigLoadOptions, type TrustedClock } from '#platform/index.js';
import { configuredModelInvocationDeliverySurfaces } from './delivery-audit.js';
import { randomUUID } from 'node:crypto';
import { ModelInvocationError, modelInvocationCommandInputSchema, modelInvocationProfileSchema, type ModelInvocationCommand, type ModelInvocationDeltaSink } from '#domain/index.js';
import { ModelInvocationApplication, ModelInvocationPolicyAuthorization, ModelBindingApplication, ModelActivationApplication, ModelActivationPolicyAuthorization, assessModelInvocationProfileDeliveries, type ModelInvocationControllers, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, openSqliteModelActivationReader, openSqliteModelActivationStore, type LocalPeerIdentity } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';
import { createConfiguredModelInvocationNative } from './native.js';
import { modelSpendRefusal } from './spend-refusal.js';
export interface RuntimeModelInvocationHost { readonly ownerId: string; readonly controllers: ModelInvocationControllers; readonly clock?: TrustedClock }
/** A direct local invocation. A claimed operation is never sent again by receipt replay. */
export async function invokeConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal, delivery?: ModelInvocationDelivery) { return invoke(input, scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, delivery); }
/** S4B-3: a composition-root workload (the memory evaluator) invokes under its own verified principal and grants (V5); no client channel reaches it. */
export async function invokeConfiguredModelAs(projectRoot: string, input: ModelInvocationCommand, principal: Awaited<ReturnType<typeof loadInvocationContext>>['principal'], options: ConfigLoadOptions = {}) {
  return invoke(input, async scopeId => Object.freeze({ ...await loadInvocationContext(projectRoot, scopeId, options, 'write'), principal }), options, undefined, undefined, undefined, undefined, 'feature');
}
export async function previewConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}) { try { return await application(await loadInvocationContext(projectRoot, input.scopeId, options, 'read'), options).preview(input); } catch (error) { throw queryFailure(error); } }
/** Internal runtime wiring only. A missing/invalid peer never falls back to process identity. */
export async function invokePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, signal?: AbortSignal) { return invoke(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, delivery, host, onDelta); }
async function invoke(input: ModelInvocationCommand, loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>, options: ConfigLoadOptions, signal?: AbortSignal, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, entry: 'raw' | 'feature' = 'raw', onNotice?: (text: string) => void | Promise<void>) {
  try {
    const command = parsedCommand(input), context = await loadContext(command.scopeId);
    const app = application(context, options, host, false, entry, configuredContinuationPin(input));
    const result = await app.invoke(command, undefined, signal, delivery, onDelta).catch(error => modelSpendRefusal(context, command.scopeId, error));
    if (entry !== 'feature' || !onDelta || !onNotice) return result;
    const next = await prepareConfiguredSiwcContinuation(context, options, command, result, value => app.preview(value, undefined, signal),
      reference => onNotice(`${t('siwc.switch.notice', { model: reference.modelId }, context.config.language)}\n`), signal);
    return next ? application(context, options, host, false, entry, configuredContinuationPin(next)).invoke(next, undefined, signal, delivery, onDelta) : result;
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
    return await application(await loadContext(command.scopeId), options, undefined, false, entry).measure(command, undefined, signal);
  } catch (error) { throw queryFailure(error); }
}
function parsedCommand(input: ModelInvocationCommand) {
  const parsed = modelInvocationCommandInputSchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data as ModelInvocationCommand;
}
export function application(context: Awaited<ReturnType<typeof loadInvocationContext>>, options: ConfigLoadOptions, host?: RuntimeModelInvocationHost, readOnly = false, entry: 'raw' | 'feature' = 'raw', profileGuard?: (profile: import('#domain/index.js').ModelInvocationProfile) => Promise<void>) {
  // One trusted clock for pricing and durable invocation records (I40).
  const clock = host?.clock ?? new SystemTrustedClock(), configuredNative = createConfiguredModelInvocationNative(context, options, clock, readOnly);
  const verifier = { async verify() { return context.principal; } }, bindings = new ModelBindingApplication({ async read() { return (await context.freshConfig())['provider_catalog']; } });
  return new ModelInvocationApplication(verifier, new ModelInvocationPolicyAuthorization(context.policy), bindings,
    async () => openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
    { async resolve(scopeId, reference) {
      const configured = (await context.freshConfig())['provider_invocation_profiles'] as { profiles: unknown[] } | undefined;
      const profiles = configured?.profiles.map(value => modelInvocationProfileSchema.parse(value)) ?? [];
      const profile = profiles.find(profile => profile.scopeId === scopeId && JSON.stringify(profile.reference) === JSON.stringify(reference)) ?? null;
      if (profile && profileGuard) await profileGuard(profile);
      return profile;
    } },
    configuredNative.natives, async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
    { invocationId: randomUUID, ownerId: () => host?.ownerId ?? randomUUID(), now: () => clock.sample().wallMs, ...(host ? { register: host.controllers.register.bind(host.controllers) } : {}) }, configuredNative.spending, async command => {
      const config = await context.freshConfig();
      return new ModelActivationApplication(verifier, new ModelActivationPolicyAuthorization(context.policy), bindings,
        async () => openSqliteModelActivationStore(await context.path(), config.storage.sqlite, 'forbid'), () => clock.sample().wallMs,
        { profiles: config['provider_invocation_profiles'], surfaces: configuredModelInvocationDeliverySurfaces(config), assess: assessModelInvocationProfileDeliveries }).admit(command);
    }, entry);
}

/** Connected application features only; no wire field selects this path. */
export async function invokeConfiguredFeatureModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return invoke(input, scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, undefined, undefined, undefined, 'feature');
}
export async function invokePeerConfiguredFeatureModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, signal?: AbortSignal, onNotice?: (text: string) => void | Promise<void>) {
  return invoke(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, delivery, host, onDelta, 'feature', onNotice);
}

/** Brain keeps its explicit source lineage when an authorized billing continuation changes the model reference. */
export async function prepareConfiguredFeatureContinuation(root: string, command: ModelInvocationCommand, result: import('#engine/index.js').ModelInvocationResult,
  options: ConfigLoadOptions, notice: (reference: import('#domain/index.js').ModelReference) => void,
  guard: (next: ModelInvocationCommand) => Promise<unknown>, signal?: AbortSignal): Promise<ModelInvocationCommand | null> {
  const context = await loadInvocationContext(root, command.scopeId, options, 'write'), app = application(context, options, undefined, false, 'feature');
  return prepareConfiguredSiwcContinuation(context, options, command, result, async next => { await guard(next); return app.preview(next, undefined, signal); }, notice, signal);
}
