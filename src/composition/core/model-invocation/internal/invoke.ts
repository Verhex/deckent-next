import { configuredModelInvocationDeliverySurfaces } from './delivery-audit.js';
import { randomUUID } from 'node:crypto';
import { ModelInvocationError, modelInvocationCommandInputSchema, modelInvocationProfileSchema, type ModelInvocationCommand, type ModelInvocationDeltaSink } from '#domain/index.js';
import { ModelInvocationApplication, ModelInvocationPolicyAuthorization, ModelBindingApplication, ModelActivationApplication, ModelActivationPolicyAuthorization, assessModelInvocationProfileDeliveries, type ModelInvocationControllers, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, openSqliteModelActivationReader, openSqliteModelActivationStore, type LocalPeerIdentity } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';
import { createConfiguredModelInvocationNative } from './native.js';
import { modelSpendRefusal } from './spend-refusal.js';
export interface RuntimeModelInvocationHost { readonly ownerId: string; readonly controllers: ModelInvocationControllers }
/** A direct local invocation. A claimed operation is never sent again by receipt replay. */
export async function invokeConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}, signal?: AbortSignal, delivery?: ModelInvocationDelivery) { return invoke(input, scopeId => loadInvocationContext(projectRoot, scopeId, options, 'write'), options, signal, delivery); }
export async function previewConfiguredModel(projectRoot: string, input: ModelInvocationCommand, options: ConfigLoadOptions = {}) { try { return await application(await loadInvocationContext(projectRoot, input.scopeId, options, 'read'), options).preview(input); } catch (error) { throw queryFailure(error); } }
/** Internal runtime wiring only. A missing/invalid peer never falls back to process identity. */
export async function invokePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink, signal?: AbortSignal) { return invoke(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'), options, signal, delivery, host, onDelta); }
async function invoke(input: ModelInvocationCommand, loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>, options: ConfigLoadOptions, signal?: AbortSignal, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost, onDelta?: ModelInvocationDeltaSink) {
  try {
    const parsed = modelInvocationCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const command = parsed.data as ModelInvocationCommand, context = await loadContext(command.scopeId);
    return await application(context, options, host).invoke(command, undefined, signal, delivery, onDelta).catch(error => modelSpendRefusal(context, command.scopeId, error));
  } catch (error) { throw queryFailure(error); }
}
/** Context measurement of a command (T-L5, runtime-internal): the provider's count of exactly what `invoke` would send, under the same peer principal, policy, binding, activation and profile checks; null when the model or server has no counter. */
export async function measurePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand, peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  try {
    const parsed = modelInvocationCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const command = parsed.data as ModelInvocationCommand, context = await loadPeerInvocationContext(projectRoot, command.scopeId, options, peer, 'write');
    return await application(context, options).measure(command, undefined, signal);
  } catch (error) { throw queryFailure(error); }
}
function application(context: Awaited<ReturnType<typeof loadInvocationContext>>, options: ConfigLoadOptions, host?: RuntimeModelInvocationHost) {
  // One trusted clock for pricing and durable invocation records (I40).
  const clock = new SystemTrustedClock(), configuredNative = createConfiguredModelInvocationNative(context, options, clock);
  const verifier = { async verify() { return context.principal; } }, bindings = new ModelBindingApplication({ async read() { return (await context.freshConfig())['provider_catalog']; } });
  return new ModelInvocationApplication(verifier, new ModelInvocationPolicyAuthorization(context.policy), bindings,
    async () => openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
    { async resolve(scopeId, reference) {
      const configured = (await context.freshConfig())['provider_invocation_profiles'] as { profiles: unknown[] } | undefined;
      const profiles = configured?.profiles.map(value => modelInvocationProfileSchema.parse(value)) ?? [];
      return profiles.find(profile => profile.scopeId === scopeId && JSON.stringify(profile.reference) === JSON.stringify(reference)) ?? null;
    } },
    configuredNative.natives, async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
    { invocationId: randomUUID, ownerId: () => host?.ownerId ?? randomUUID(), now: () => clock.sample().wallMs, ...(host ? { register: host.controllers.register.bind(host.controllers) } : {}) }, configuredNative.spending, async command => {
      const config = await context.freshConfig();
      return new ModelActivationApplication(verifier, new ModelActivationPolicyAuthorization(context.policy), bindings,
        async () => openSqliteModelActivationStore(await context.path(), config.storage.sqlite, 'forbid'), () => clock.sample().wallMs,
        { profiles: config['provider_invocation_profiles'], surfaces: configuredModelInvocationDeliverySurfaces(config), assess: assessModelInvocationProfileDeliveries }).admit(command);
    });
}
