import { randomUUID } from 'node:crypto';
import { ModelInvocationError, modelInvocationCommandInputSchema, modelInvocationProfileSchema, type ModelInvocationCommand } from '#domain/index.js';
import { ModelInvocationApplication, ModelInvocationPolicyAuthorization, ModelBindingApplication, type ModelInvocationControllers, type ModelInvocationDelivery } from '#engine/index.js';
import { openSqliteModelInvocationStore, openSqliteModelActivationReader, type LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadInvocationContext, loadPeerInvocationContext } from './context.js';
import { createConfiguredModelInvocationNative } from './native.js';

export interface RuntimeModelInvocationHost { readonly ownerId: string; readonly controllers: ModelInvocationControllers }

/** A direct local invocation. A claimed operation is never sent again by receipt replay. */
export async function invokeConfiguredModel(projectRoot: string, input: ModelInvocationCommand,
  options: ConfigLoadOptions = {}, signal?: AbortSignal, delivery?: ModelInvocationDelivery) {
  return invoke(input, scopeId => loadInvocationContext(projectRoot, scopeId, options), options, signal, delivery);
}
/** Internal runtime wiring only. A missing/invalid peer never falls back to process identity. */
export async function invokePeerConfiguredModel(projectRoot: string, input: ModelInvocationCommand,
  peer: LocalPeerIdentity, options: ConfigLoadOptions = {}, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost) {
  return invoke(input, scopeId => loadPeerInvocationContext(projectRoot, scopeId, options, peer), options, undefined, delivery, host);
}
async function invoke(input: ModelInvocationCommand,
  loadContext: (scopeId: string) => ReturnType<typeof loadInvocationContext>, options: ConfigLoadOptions, signal?: AbortSignal, delivery?: ModelInvocationDelivery, host?: RuntimeModelInvocationHost) {
  try {
    const parsed = modelInvocationCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const command = parsed.data as ModelInvocationCommand;
    const context = await loadContext(command.scopeId);
    const configuredNative = createConfiguredModelInvocationNative(context, options);
    const application = new ModelInvocationApplication({ async verify() { return context.principal; } },
      new ModelInvocationPolicyAuthorization(context.policy),
      new ModelBindingApplication({ async read() { return (await context.freshConfig())['provider_catalog']; } }),
      async () => openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
      { async resolve(scopeId, reference) {
        const configured = (await context.freshConfig())['provider_invocation_profiles'] as { profiles: unknown[] } | undefined;
        const profiles = configured?.profiles.map(value => modelInvocationProfileSchema.parse(value)) ?? [];
        return profiles.find(profile => profile.scopeId === scopeId
          && JSON.stringify(profile.reference) === JSON.stringify(reference)) ?? null;
      } },
      configuredNative.natives,
      async () => openSqliteModelInvocationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
      { invocationId: randomUUID, ownerId: () => host?.ownerId ?? randomUUID(), now: Date.now,
        ...(host ? { register: host.controllers.register.bind(host.controllers) } : {}) }, configuredNative.spending);
    return await application.invoke(command, undefined, signal, delivery);
  } catch (error) { throw queryFailure(error); }
}
