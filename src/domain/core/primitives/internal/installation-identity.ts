import { z } from 'zod';

/** Durable installation metadata; neither a host/path fingerprint nor an authorization grant. */
export const installationIdSchema = z.string().uuid().brand<'InstallationId'>();
export type InstallationId = z.infer<typeof installationIdSchema>;
export const installationIdentitySchema = z.object({ schemaVersion: z.literal(1), installationId: installationIdSchema }).strict().readonly();
export type InstallationIdentity = z.infer<typeof installationIdentitySchema>;

/** Local relocation evidence, never an authorization credential. The machine value is app-specific. */
export const installationBindingSchema = z.object({
  schemaVersion: z.literal(1), machineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalRoot: z.string().min(1), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/),
}).strict().readonly();
export type InstallationBinding = z.infer<typeof installationBindingSchema>;
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
/** v1 is readable only to support an explicit operator decision; it is never trusted as bound. */
export const installationIdentityRecordSchema = z.union([boundInstallationIdentitySchema, installationIdentitySchema]);
