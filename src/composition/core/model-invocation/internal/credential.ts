import type { ModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationStoreError } from '#engine/index.js';
import type { NativeJsonHttpAuthentication } from '#adapters/index.js';
import { configuredSecretResolver, type ConfigLoadOptions } from '#platform/index.js';
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
    // SECRET-K1: the installation's one configured resolver (explicit > selected backend > environment); a backend refusal stays typed.
    const value = await configuredSecretResolver(context.config, options)(reference);
    // A backend may finish after revocation or deadline. It never authorizes a socket by itself.
    guard(signal); await revalidate(signal);
    return value;
  };
}
