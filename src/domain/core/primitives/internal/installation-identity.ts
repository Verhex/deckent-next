import { z } from 'zod';

/** Durable installation metadata; neither a host/path fingerprint nor an authorization grant. */
export const installationIdSchema = z.string().uuid().brand<'InstallationId'>();
export type InstallationId = z.infer<typeof installationIdSchema>;
export const installationIdentitySchema = z.object({ schemaVersion: z.literal(1), installationId: installationIdSchema }).strict().readonly();
export type InstallationIdentity = z.infer<typeof installationIdentitySchema>;

const bindingLocation = { canonicalRoot: z.string().min(1), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/) };
const machineDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Local relocation evidence, never an authorization credential. The machine value is app-specific (keyed digest, never raw). */
const legacyInstallationBindingSchema = z.object({ schemaVersion: z.literal(1), machineDigest: machineDigestSchema, ...bindingLocation }).strict().readonly();
/**
 * Binding v2 states its strength and source. `machine` carries a keyed digest of a configured or platform machine identity;
 * `weak` has no machine identity and binds only canonical root, device and inode, so a copy, restore or new container is still detected.
 * Strength and source kinds are versioned invariants (each has its own capture code), not an extensible vocabulary.
 */
export const installationBindingCaptureSchema = z.discriminatedUnion('strength', [
  z.object({ schemaVersion: z.literal(2), strength: z.literal('machine'), source: z.union([z.literal('configured'), z.literal('platform')]),
    machineDigest: machineDigestSchema, ...bindingLocation }).strict(),
  z.object({ schemaVersion: z.literal(2), strength: z.literal('weak'), source: z.literal('location'), ...bindingLocation }).strict(),
]).readonly();
/** Retained records hold the v1 shape (always platform machine strength) or v2 (configured source or weak). */
export const installationBindingSchema = z.union([installationBindingCaptureSchema, legacyInstallationBindingSchema]);
export type InstallationBinding = z.infer<typeof installationBindingSchema>;
export type InstallationBindingCapture = z.infer<typeof installationBindingCaptureSchema>;
/**
 * The shape a capture is persisted in (expand/contract): a platform machine binding keeps the v1 shape so a rollback to a release that only
 * reads v1 stays valid; only bindings the v1 shape cannot express (configured source, weak) are written as v2.
 */
export function retainedInstallationBinding(capture: InstallationBindingCapture): InstallationBinding {
  if (capture.strength !== 'machine' || capture.source !== 'platform') return capture;
  return legacyInstallationBindingSchema.parse({ schemaVersion: 1, machineDigest: capture.machineDigest,
    canonicalRoot: capture.canonicalRoot, device: capture.device, inode: capture.inode });
}
export type InstallationBindingStrength = InstallationBindingCapture['strength'];
export type InstallationBindingSourceKind = InstallationBindingCapture['source'];
export const installationIdentityChoiceSchema = z.enum(['keep', 'new']);
export type InstallationIdentityChoice = z.infer<typeof installationIdentityChoiceSchema>;
export const installationIdentityResolutionSchema = z.object({
  schemaVersion: z.literal(1), choice: installationIdentityChoiceSchema, previousInstallationId: installationIdSchema, installationId: installationIdSchema,
  at: z.string().datetime(), principal: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict().readonly(),
}).strict().readonly();
export type InstallationIdentityResolution = z.infer<typeof installationIdentityResolutionSchema>;
export const boundInstallationIdentitySchema = z.object({ schemaVersion: z.literal(2), installationId: installationIdSchema,
  binding: installationBindingSchema, lastResolution: installationIdentityResolutionSchema.nullable(),
}).strict().readonly();
/** An unbound v1 record is never trusted as bound: on a machine-capable host it needs an explicit operator decision; on a host with only
 * weak binding the next write path binds it (weak) under the identity writer lock. Reads never upgrade. */
export const installationIdentityRecordSchema = z.union([boundInstallationIdentitySchema, installationIdentitySchema]);
