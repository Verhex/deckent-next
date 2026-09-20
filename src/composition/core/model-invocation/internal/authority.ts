import { modelInvocationProfileSchema, type ModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationPolicyAuthorization, ModelInvocationStoreError, modelInvocationProfileDigest } from '#engine/index.js';
import type { loadInvocationContext } from './context.js';

/** Shared fresh authorization for metadata acquisition and credential resolution. */
export function invocationEffectAuthority(context: Awaited<ReturnType<typeof loadInvocationContext>>,
  profile: ModelInvocationProfile) {
  const expected = modelInvocationProfileDigest(profile);
  const authorization = new ModelInvocationPolicyAuthorization(context.policy);
  const guard = (signal?: AbortSignal) => {
    if (signal?.aborted || !context.principal.scopeIds.includes(profile.scopeId)) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    }
  };
  return async (signal?: AbortSignal) => {
    guard(signal);
    const config = await context.freshConfig(); guard(signal);
    const configured = config['provider_invocation_profiles'] as { profiles: unknown[] } | undefined;
    const current = configured?.profiles.map(value => modelInvocationProfileSchema.parse(value))
      .find(value => value.scopeId === profile.scopeId && value.id === profile.id);
    if (!current || modelInvocationProfileDigest(current) !== expected) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    await authorization.authorize('invoke', { scopeId: profile.scopeId, reference: profile.reference }, context.principal);
    guard(signal);
    return config;
  };
}
