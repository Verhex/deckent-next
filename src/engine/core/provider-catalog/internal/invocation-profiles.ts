import type { ModelInvocationProfile } from '#domain/index.js';

/** Effective configuration has already passed the registered section and authored-layer validators. */
export function configuredInvocationProfiles(config: Readonly<Record<string, unknown>>): readonly ModelInvocationProfile[] {
  return (config['provider_invocation_profiles'] as { readonly profiles?: readonly ModelInvocationProfile[] } | undefined)?.profiles ?? [];
}
