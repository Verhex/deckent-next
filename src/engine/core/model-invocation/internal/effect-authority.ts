import { configuredInvocationProfiles } from '#engine/core/provider-catalog/index.js';
import { type ModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';
import { modelInvocationProfileDigest } from './evidence.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { ModelInvocationAuthorizer } from './application.js';


/** Shared fresh authorization for metadata acquisition and credential resolution. */
export function invocationEffectAuthority<C extends Readonly<Record<string, unknown>>>(context: { principal: VerifiedPrincipal; freshConfig(): Promise<C> },
  profile: ModelInvocationProfile, authorization: ModelInvocationAuthorizer) {
  const expected = modelInvocationProfileDigest(profile);
  const guard = (signal?: AbortSignal) => {
    if (signal?.aborted || !context.principal.scopeIds.includes(profile.scopeId)) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    }
  };
  return async (signal?: AbortSignal) => {
    guard(signal);
    const config = await context.freshConfig(); guard(signal);
    const current = configuredInvocationProfiles(config)
      .find(value => value.scopeId === profile.scopeId && value.id === profile.id);
    if (!current || modelInvocationProfileDigest(current) !== expected) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    await authorization.authorize('invoke', { scopeId: profile.scopeId, reference: profile.reference }, context.principal);
    guard(signal);
    return config;
  };
}
