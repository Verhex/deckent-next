import { persistedString, persistedDateTime, persistedUuid } from './persisted-schema.js';
import { z } from 'zod';
/** Durable installation metadata; neither a host/path fingerprint nor an authorization grant. */
export const installationIdSchema = persistedUuid().brand<'InstallationId'>();
export type InstallationId = z.infer<typeof installationIdSchema>;
const realmSealSchema = z.strictObject({ schemaVersion: z.literal(1), fixture: z.literal('realm-sealed'), realmId: persistedString(z.string().min(1)), nonce: persistedUuid(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
export const installationIdentitySchema = z.strictObject({ schemaVersion: z.literal(1), installationId: installationIdSchema, realmSeal: realmSealSchema.optional() }).readonly();
export type InstallationIdentity = z.infer<typeof installationIdentitySchema>;

const bindingLocation = { canonicalRoot: persistedString(z.string().min(1)), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/) };
const machineDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Local relocation evidence, never an authorization credential. The machine value is app-specific (keyed digest, never raw). */
const legacyInstallationBindingSchema = z.strictObject({ schemaVersion: z.literal(1), machineDigest: machineDigestSchema, ...bindingLocation }).readonly();
/**
 * Binding v2 states its strength and source. `machine` carries a keyed digest of a configured or platform machine identity;
 * `weak` has no machine identity and binds only canonical root, device and inode, so a copy, restore or new container is still detected.
 * Strength and source kinds are versioned invariants (each has its own capture code), not an extensible vocabulary.
 */
const machineBindingSchema = z.strictObject({ schemaVersion: z.literal(2), strength: z.literal('machine'), source: z.union([z.literal('configured'), z.literal('platform')]),
  machineDigest: machineDigestSchema, ...bindingLocation });
const weakBindingSchema = z.strictObject({ schemaVersion: z.literal(2), strength: z.literal('weak'), source: z.literal('location'), ...bindingLocation });
const writableInstallationBindingSchema = z.discriminatedUnion('strength', [machineBindingSchema, weakBindingSchema]).readonly();
export const filesystemIdentitySchema = z.strictObject({ kind: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9.-]*$/u),
  value: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u) }).readonly();
export type FilesystemIdentity = z.infer<typeof filesystemIdentitySchema>;
/** Observation only in R: the writer deliberately strips filesystem identity. */
const filesystemObservation = { filesystemIdentity: filesystemIdentitySchema.optional() };
export const installationBindingCaptureSchema = z.discriminatedUnion('strength', [machineBindingSchema.extend(filesystemObservation),
  weakBindingSchema.extend(filesystemObservation)]).readonly();
/** Binding v3 is machine-strength only. Its recorded device is information, not comparison evidence. */
const filesystemInstallationBindingSchema = z.strictObject({ schemaVersion: z.literal(3), strength: z.literal('machine'),
  source: z.union([z.literal('configured'), z.literal('platform')]), machineDigest: machineDigestSchema, ...bindingLocation,
  filesystemIdentity: filesystemIdentitySchema }).readonly();
/** R understands v3, but only writes the unchanged v1/v2 shapes. Outer record versions retain their meaning. */
export const installationBindingSchema = z.union([writableInstallationBindingSchema, legacyInstallationBindingSchema, filesystemInstallationBindingSchema]);
export type InstallationBinding = z.infer<typeof installationBindingSchema>;
export type InstallationBindingCapture = z.infer<typeof installationBindingCaptureSchema>;
export type WritableInstallationBinding = z.infer<typeof writableInstallationBindingSchema> | z.infer<typeof legacyInstallationBindingSchema>;
/** Frozen beta.1.2 capture bytes/order for unversioned digests; additive observations need an explicit versioned opt-in. */
export function installationBindingCaptureV2Projection(capture: InstallationBindingCapture): z.infer<typeof writableInstallationBindingSchema> {
  return writableInstallationBindingSchema.parse({ schemaVersion: capture.schemaVersion, strength: capture.strength, source: capture.source,
    ...(capture.strength === 'machine' ? { machineDigest: capture.machineDigest } : {}),
    canonicalRoot: capture.canonicalRoot, device: capture.device, inode: capture.inode });
}
/**
 * The shape a capture is persisted in (expand/contract): a platform machine binding keeps the v1 shape so a rollback to a release that only
 * reads v1 stays valid; only bindings the v1 shape cannot express (configured source, weak) are written as v2.
 */
export function retainedInstallationBinding(capture: InstallationBindingCapture): WritableInstallationBinding {
  const writable = { ...installationBindingCaptureSchema.parse(capture) };
  delete writable.filesystemIdentity;
  if (writable.strength !== 'machine' || writable.source !== 'platform') return writableInstallationBindingSchema.parse(writable);
  return legacyInstallationBindingSchema.parse({ schemaVersion: 1, machineDigest: writable.machineDigest,
    canonicalRoot: writable.canonicalRoot, device: writable.device, inode: writable.inode });
}
export type InstallationBindingStrength = InstallationBindingCapture['strength'];
export type InstallationBindingSourceKind = InstallationBindingCapture['source'];
export const installationIdentityChoiceSchema = z.enum(['keep', 'new']);
export type InstallationIdentityChoice = z.infer<typeof installationIdentityChoiceSchema>;
export const installationIdentityResolutionSchema = z.strictObject({
  schemaVersion: z.literal(1), choice: installationIdentityChoiceSchema, previousInstallationId: installationIdSchema, installationId: installationIdSchema,
  at: persistedDateTime(), principal: z.strictObject({ issuer: persistedString(z.string().min(1)), subject: persistedString(z.string().min(1)) }).readonly(),
}).readonly();
export type InstallationIdentityResolution = z.infer<typeof installationIdentityResolutionSchema>;
export const boundInstallationIdentitySchema = z.strictObject({ schemaVersion: z.literal(2), installationId: installationIdSchema,
  binding: installationBindingSchema, lastResolution: installationIdentityResolutionSchema.nullable(),
}).readonly();
/** An unbound v1 record is never trusted as bound: on a machine-capable host it needs an explicit operator decision; on a host with only
 * weak binding the next write path binds it (weak) under the identity writer lock. Reads never upgrade. */
const sealedInstallationIdentitySchema = z.strictObject({ schemaVersion: z.literal(3), installationId: installationIdSchema,
  binding: installationBindingSchema, lastResolution: installationIdentityResolutionSchema.nullable(), realmSeal: realmSealSchema }).readonly();
export const installationIdentityRecordSchema = z.union([sealedInstallationIdentitySchema, boundInstallationIdentitySchema, installationIdentitySchema]);
