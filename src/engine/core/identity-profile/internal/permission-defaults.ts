import { z } from 'zod';
import { identityProfileRefSchema, IdentityProfileError, type IdentityProfileRef } from '#domain/index.js';
import data from './permission-defaults.json' with { type: 'json' };
const entry = z.object({ profile: identityProfileRefSchema, openModes: z.array(z.enum(['full-auto', 'full-access'])).max(2),
  startMode: z.enum(['standart', 'full-auto', 'full-access']), ownerBaseline: z.object({ families: z.array(z.string().min(1)).max(64) }).strict() }).strict()
  .refine(row => row.startMode === 'standart' || row.openModes.includes(row.startMode));
const defaults = z.object({ schemaVersion: z.literal(1), entries: z.array(entry).max(64) }).strict().parse(data);
export type ProfilePermissionDefaults = z.infer<typeof entry>;
/** Separate versioned defaults: saved profile definitions and their digests remain unchanged. */
export class PermissionDefaultsRegistry {
  private entries: ProfilePermissionDefaults[] = [...defaults.entries];
  private sealed = false;
  register(inputs: readonly unknown[]): void {
    if (this.sealed) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    const rows = inputs.map(input => entry.parse(input));
    if (this.entries.length + rows.length > 64) throw new IdentityProfileError('IDENTITY_PROFILE_INVALID');
    const seen = new Set(this.entries.map(row => JSON.stringify(row.profile)));
    for (const row of rows) {
      const key = JSON.stringify(row.profile);
      if (row.profile.id.startsWith('core:') || seen.has(key)) throw new IdentityProfileError('IDENTITY_PROFILE_SHADOW');
      seen.add(key);
    }
    this.entries.push(...structuredClone(rows));
  }
  resolve(profile: IdentityProfileRef | null): ProfilePermissionDefaults | null {
    this.sealed = true;
    return structuredClone(this.entries.find(row => row.profile.id === profile?.id && row.profile.version === profile.version) ?? null);
  }
}
export const permissionDefaultsRegistry = new PermissionDefaultsRegistry();
