import { coreIdentityProfileData, encodeIdentityProfile, IdentityProfileError, identityProfileDefinitionSchema, identityProfilePackageSchema,
  identityProfileRefSchema, type IdentityProfileDefinition, type IdentityProfileRef } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
export interface IdentityProfileEntry { readonly definition: IdentityProfileDefinition; readonly digest: string; readonly namespace: string;
  readonly source: string; readonly labels: Readonly<{ en: string; tr: string }> | null }
/** Immutable registry snapshot. Extensions add data under their own namespace, never replace Core or an existing version. */
export class IdentityProfileRegistry {
  readonly version: number;
  readonly digest: string;
  private readonly entries: readonly IdentityProfileEntry[];
  constructor(packages: readonly unknown[] = []) {
    const entries: IdentityProfileEntry[] = coreIdentityProfileData.profiles.map(input => {
      const definition = identityProfileDefinitionSchema.parse(input);
      return Object.freeze({ definition, digest: sha256(encodeIdentityProfile(definition)), namespace: 'core', source: 'core', labels: null });
    });
    if (packages.length > 64) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    for (const input of packages) {
      const parsed = identityProfilePackageSchema.safeParse(input);
      if (!parsed.success) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
      const value = parsed.data;
      if (value.namespace === 'core' || value.definition.id.startsWith('core:')) throw new IdentityProfileError('IDENTITY_PROFILE_SHADOW');
      if (value.definition.id.split(':')[0] !== value.namespace) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
      if (entries.some(entry => entry.definition.id === value.definition.id && entry.definition.version === value.definition.version)) throw new IdentityProfileError('IDENTITY_PROFILE_SHADOW');
      if (sha256(encodeIdentityProfile(value.definition)) !== value.digest) throw new IdentityProfileError('IDENTITY_PROFILE_DIGEST_MISMATCH');
      entries.push(Object.freeze({ definition: value.definition, namespace: value.namespace, source: value.source, digest: value.digest, labels: value.labels }));
    }
    this.entries = Object.freeze(entries.sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : a.definition.version - b.definition.version));
    this.version = coreIdentityProfileData.version;
    this.digest = sha256(encodeIdentityProfile({ version: this.version, entries: this.entries }));
    Object.freeze(this);
  }
  list(): readonly IdentityProfileEntry[] { return this.entries; }
  resolve(input: IdentityProfileRef): IdentityProfileEntry {
    const parsed = identityProfileRefSchema.safeParse(input);
    if (!parsed.success) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    const ref = parsed.data, namespace = ref.id.split(':')[0];
    if (!this.entries.some(entry => entry.namespace === namespace)) throw new IdentityProfileError('IDENTITY_PROFILE_NAMESPACE_UNKNOWN');
    if (!this.entries.some(entry => entry.definition.id === ref.id)) throw new IdentityProfileError('IDENTITY_PROFILE_UNKNOWN');
    const entry = this.entries.find(entry => entry.definition.id === ref.id && entry.definition.version === ref.version);
    if (!entry) throw new IdentityProfileError('IDENTITY_PROFILE_VERSION_UNKNOWN');
    return entry;
  }
}
