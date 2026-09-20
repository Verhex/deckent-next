import type { ModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationStoreError } from '#engine/index.js';
import type { NativeJsonHttpAuthentication } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { loadInvocationContext } from './context.js';
import { invocationEffectAuthority } from './authority.js';

/** Values remain in this one runtime send; config and durable profiles contain only bare references. */
export function scopedInvocationCredentialResolver(context: Awaited<ReturnType<typeof loadInvocationContext>>,
  profile: ModelInvocationProfile, authentication: NativeJsonHttpAuthentication, options: ConfigLoadOptions) {
  const revalidate = invocationEffectAuthority(context, profile);
  const guard = (signal?: AbortSignal) => { if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE'); };
  return async (reference: string, signal?: AbortSignal): Promise<string | undefined> => {
    if (authentication.type !== 'bearer' || authentication.credentialRef !== reference
      || !context.principal.scopeIds.includes(profile.scopeId)) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    await revalidate(signal);
    const env = options.env ?? process.env;
    const value = options.secretResolver ? await options.secretResolver(reference) : Object.hasOwn(env, reference) ? env[reference] : undefined;
    // A backend may finish after revocation or deadline. It never authorizes a socket by itself.
    guard(signal); await revalidate(signal);
    return value;
  };
}
