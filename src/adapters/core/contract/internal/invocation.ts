import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { modelInvocationProfileSchema, parseModelInvocationProfile } from '#domain/index.js';
import { ConfigValidationError, registerConfigSection, CONFIG_CONTRACT_SINCE } from '#platform/index.js';

export const invocationProfilesSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(modelInvocationProfileSchema).readonly(),
}).strict();
function invalid(): never {
  throw new ConfigValidationError([{ path: 'provider_invocation_profiles', reason: 'POLICY_AUTHORITY_INVALID' }]);
}
function validate(input: unknown) {
  const parsed = invocationProfilesSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const selections = new Set<string>(), identities = new Set<string>(), allocations = new Map<string, unknown>();
  for (const raw of parsed.data.profiles) {
    let profile;
    try { profile = parseModelInvocationProfile(raw); } catch { return invalid(); }
    const reference = profile.reference;
    const selection = JSON.stringify([profile.scopeId, reference.providerId, reference.providerVersion, reference.modelId, reference.modelVersion]);
    const identity = JSON.stringify([profile.scopeId, profile.id]);
    if (selections.has(selection) || identities.has(identity)) invalid();
    selections.add(selection); identities.add(identity);
    const allocation = JSON.stringify([profile.scopeId, profile.allocation.id]);
    if (allocations.has(allocation) && !isDeepStrictEqual(allocations.get(allocation), profile.allocation)) invalid();
    allocations.set(allocation, profile.allocation);
  }
  return parsed.data;
}
/** An authored parent is authority: project snapshots can select a subset, not replace its grants or ceilings. */
export function validateInvocationProfileLayers(global: unknown, project: unknown): void {
  const parent = global === undefined ? undefined : validate(global);
  if (project === undefined) return;
  const child = validate(project);
  if (!parent) return;
  for (const profile of child.profiles) {
    if (!parent.profiles.some(candidate => isDeepStrictEqual(candidate, profile))) invalid();
  }
}
export function registerInvocationProfileConfig(): void {
  registerConfigSection('provider_invocation_profiles', invocationProfilesSchema, {
    optional: true, secretReferences: 'forbid',
    metadata: { descriptionKey: 'config.field.provider_invocation_profiles', tier: 'core', since: CONFIG_CONTRACT_SINCE },
    validateLayers: validateInvocationProfileLayers,
    validateValue: value => { if (value !== undefined) validate(value); },
  });
}
