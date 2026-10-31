import { encodeModelBindingDefinition, modelInvocationProfileSchema, resolveModelBindingDefinition, type ModelReference, type ModelBindingDefinition } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { isDeepStrictEqual } from 'node:util';
import { ConfigApplicationError, type ConfigSnapshot, type ConfigWriteInput } from './contract.js';

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

/** Only the selected profile, already bound to the old declaration, may follow a capability-only change. All other bindings still use the guard. */
export function capabilityProfileChange(snapshot: ConfigSnapshot, input: ConfigWriteInput,
  target: Readonly<{ reference: ModelReference; adapter: unknown; protocol: unknown }>): readonly ConfigWriteInput[] {
  if (input.keyPath !== 'provider_catalog') throw new ConfigApplicationError('CONFIG_MODEL_PROFILE_REBIND_REQUIRED');
  const before = snapshot.document['provider_catalog'];
  if (before === undefined) return [];
  const previous = resolveModelBindingDefinition(before, target.reference), next = resolveModelBindingDefinition(input.value, target.reference);
  if (!previous || !next || encodeModelBindingDefinition(previous) === encodeModelBindingDefinition(next)) return [];
  if (snapshot.layer === 'global' && snapshot.project['provider_catalog'] !== undefined) throw new ConfigApplicationError('CONFIG_MODEL_PROFILE_REBIND_REQUIRED');
  const identity = (binding: ModelBindingDefinition) => ({ ...binding, model: { ...binding.model,
    protocols: binding.model.protocols.map(protocol => ({ ...protocol, capabilities: [] })) } });
  const section = snapshot.document['provider_invocation_profiles'] as { profiles?: Record<string, unknown>[] } | undefined;
  let changed = false;
  const profiles = (section?.profiles ?? []).map(value => {
    const profile = modelInvocationProfileSchema.parse(value);
    if (profile.scopeId !== input.scopeId || !isDeepStrictEqual(profile.reference, target.reference)) return value;
    if (changed || !isDeepStrictEqual(identity(previous), identity(next)) || profile.bindingDigest !== sha256(encodeModelBindingDefinition(previous))
      || !isDeepStrictEqual(profile.adapter, target.adapter) || !isDeepStrictEqual(profile.protocol, target.protocol)) {
      throw new ConfigApplicationError('CONFIG_MODEL_PROFILE_REBIND_REQUIRED', { profile: profile.id, scope: profile.scopeId });
    }
    changed = true; return { ...value, version: profile.version + 1, bindingDigest: sha256(encodeModelBindingDefinition(next)) };
  });
  return changed ? [{ ...input, keyPath: 'provider_invocation_profiles', value: { ...section, profiles }, expect: snapshot.digest,
    commandId: `${input.commandId}.rebind` }] : [];
}
