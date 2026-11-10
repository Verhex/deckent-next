import { modelInvocationProfileSchema, type ModelInvocationProfile } from '#domain/index.js';

/** Secret resolution rebuilds records with null prototypes; restore the profile contract before consumers compare them. */
export function configuredInvocationProfiles(config: Readonly<Record<string, unknown>>): readonly ModelInvocationProfile[] {
  const profiles = (config['provider_invocation_profiles'] as { readonly profiles?: readonly ModelInvocationProfile[] } | undefined)?.profiles ?? [];
  return Object.freeze(profiles.map(profile => modelInvocationProfileSchema.parse(profile)));
}
