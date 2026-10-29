import { encodeModelBindingDefinition, modelInvocationProfileSchema, resolveModelBindingDefinition } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { ConfigApplicationError, type ConfigSnapshot } from './contract.js';

/** A catalog write cannot silently invalidate profiles. Rebinding is a separate governed choice, never implicit config authority. */
export function assertCatalogProfileBindings(snapshot: ConfigSnapshot, document: Record<string, unknown>, effective: Record<string, unknown>): void {
  const check = (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const section = after['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
    for (const value of section?.profiles ?? []) {
      const profile = modelInvocationProfileSchema.parse(value);
      const binding = (config: Record<string, unknown>) => {
        const catalog = config['provider_catalog'];
        const definition = catalog === undefined ? null : resolveModelBindingDefinition(catalog, profile.reference);
        return definition === null ? null : encodeModelBindingDefinition(definition);
      };
      const previous = binding(before), next = binding(after);
      if (previous === next || next !== null && sha256(next) === profile.bindingDigest) continue;
      throw new ConfigApplicationError('CONFIG_MODEL_PROFILE_REBIND_REQUIRED', { profile: profile.id, scope: profile.scopeId });
    }
  };
  check(snapshot.effective, effective);
  // A project catalog may mask the user layer here; other projects still consume that user's catalog and profiles.
  if (snapshot.layer === 'global') check(snapshot.global, document);
}
