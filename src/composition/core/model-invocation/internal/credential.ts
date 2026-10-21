import type { ModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationStoreError } from '#engine/index.js';
import type { NativeJsonHttpAuthentication } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { assertProjectCredential, projectCredentialResolver } from '#composition/core/secrets/index.js';
import type { loadInvocationContext } from './context.js';
import { invocationEffectAuthority } from './authority.js';

/** Values remain in this one runtime send; config and durable profiles contain only bare references. */
export function scopedInvocationCredentialResolver(context: Awaited<ReturnType<typeof loadInvocationContext>>,
  profile: ModelInvocationProfile, authentication: NativeJsonHttpAuthentication, options: ConfigLoadOptions) {
  const revalidate = invocationEffectAuthority(context, profile);
  const guard = (signal?: AbortSignal) => { if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'); };
  return async (reference: string, signal?: AbortSignal): Promise<string | undefined> => {
    if (authentication.type === 'none' || authentication.credentialRef !== reference
      || !context.principal.scopeIds.includes(profile.scopeId)) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    await revalidate(signal);
    // PRE-8 v2: the one provider credential entry point (`.deck`, project vault, main vault through a grant); the main read stays SECRET-K1's
    // configured resolver (explicit > selected backend > environment); a refusal stays typed.
    const value = await projectCredentialResolver(context, profile.scopeId, options).resolve(reference);
    // A backend may finish after revocation or deadline. It never authorizes a socket by itself.
    guard(signal); await revalidate(signal);
    return value;
  };
}
/** PRE-8 v2: the pre-send decision of a profile's credential reference (no value read); a profile without one passes. */
export async function admitInvocationCredential(context: Awaited<ReturnType<typeof loadInvocationContext>>, profile: ModelInvocationProfile, options: ConfigLoadOptions) {
  const definition = profile.adapter.definition as { authentication?: NativeJsonHttpAuthentication; transport?: { authentication?: NativeJsonHttpAuthentication } };
  const authentication = definition.authentication ?? definition.transport?.authentication;
  if (authentication && authentication.type !== 'none') await assertProjectCredential(context, profile.scopeId, authentication.credentialRef, options);
}
