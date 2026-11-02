import { z } from 'zod';
import { persistedString, persistedUuid, identitySchema, installationIdSchema, projectIdSchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';

const text = persistedString(z.string().min(1).max(4096));
export const attachmentPersonSchema = z.strictObject({ issuer: identitySchema, subject: identitySchema }).readonly();
/** Location evidence detects copying; it grants no execution authority. */
export const attachmentLocationSchema = z.strictObject({ canonicalRoot: text, device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/) }).readonly();
export const installationSourceSchema = z.strictObject({ projectRoot: text, layoutRoot: text, bootstrapConfigPath: text,
  layoutRevision: z.string().regex(/^[a-f0-9]{64}$/), installationId: installationIdSchema, projectId: projectIdSchema,
  companyId: identitySchema, scopeId: identitySchema, owner: attachmentPersonSchema, location: attachmentLocationSchema }).readonly();
export const projectAttachmentSchema = z.strictObject({ schemaVersion: z.literal(1), registrationId: persistedUuid(),
  projectId: projectIdSchema, companyId: identitySchema, scopeId: identitySchema, actor: attachmentPersonSchema,
  location: attachmentLocationSchema, commandId: persistedUuid() }).readonly();
export const modelUseLeaseSchema = z.strictObject({ schemaVersion: z.literal(1), leaseId: persistedUuid(),
  state: z.enum(['pending', 'active', 'revoked']), profiles: z.array(z.strictObject({ reference: modelReferenceSchema,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    bindingDigest: z.string().regex(/^[a-f0-9]{64}$/) }).readonly()).readonly() }).readonly();
export type ModelUseLease = z.infer<typeof modelUseLeaseSchema>;
export const attachmentInventoryEntrySchema = z.strictObject({ attachment: projectAttachmentSchema, modelLease: modelUseLeaseSchema.optional(),
  preparationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), restoreDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'active', 'revoked']) }).readonly();
export const installationRegistrationSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), registrationId: persistedUuid(), unregistered: z.boolean().optional(),
  source: installationSourceSchema, entries: z.array(attachmentInventoryEntrySchema).readonly() }).superRefine((value, ctx) => {
    if (value.schemaVersion === 1 && (value.unregistered !== undefined || value.entries.some(entry => entry.modelLease || entry.preparationDigest || entry.restoreDigest))) ctx.addIssue({ code: 'custom', message: 'ATTACHMENT_INVENTORY_INVALID' });
    const ids = new Set<string>(), roots = new Set<string>(), commands = new Set<string>();
    for (const entry of value.entries) {
      const item = entry.attachment;
      if (ids.has(item.projectId) || roots.has(item.location.canonicalRoot) || commands.has(item.commandId) || item.registrationId !== value.registrationId
        || item.companyId !== value.source.companyId) ctx.addIssue({ code: 'custom', message: 'ATTACHMENT_INVENTORY_INVALID' });
      ids.add(item.projectId); roots.add(item.location.canonicalRoot); commands.add(item.commandId);
    }
  }).readonly();
export type AttachmentPerson = z.infer<typeof attachmentPersonSchema>;
export type AttachmentLocation = z.infer<typeof attachmentLocationSchema>;
export type InstallationSource = z.infer<typeof installationSourceSchema>;
export type ProjectAttachment = z.infer<typeof projectAttachmentSchema>;
export type InstallationRegistration = z.infer<typeof installationRegistrationSchema>;

const scope = identitySchema, hex = z.string().regex(/^[a-f0-9]{64}$/);
export const projectAttachmentCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('register-preview'), scopeId: scope }),
  z.strictObject({ action: z.literal('register'), scopeId: scope, expect: hex }),
  z.strictObject({ action: z.literal('preview'), scopeId: scope }),
  z.strictObject({ action: z.literal('offer'), scopeId: scope }),
  z.strictObject({ action: z.literal('apply'), scopeId: scope, expect: hex, commandId: persistedUuid() }),
  z.strictObject({ action: z.literal('revoke'), projectId: projectIdSchema }),
  z.strictObject({ action: z.literal('lease-revoke'), projectId: projectIdSchema }),
  z.strictObject({ action: z.literal('detach'), projectId: projectIdSchema }),
  z.strictObject({ action: z.literal('restore'), projectId: projectIdSchema, expect: hex }),
  z.strictObject({ action: z.literal('unregister') }),
  z.strictObject({ action: z.literal('relocate'), scopeId: scope }),
]).readonly();
export type ProjectAttachmentCommand = z.infer<typeof projectAttachmentCommandSchema>;

export const attachmentPreparationSchema = z.strictObject({ digest: hex,
  connections: z.array(z.strictObject({ reference: modelReferenceSchema, billing: z.enum(['subscription', 'metered', 'local']) }).readonly()).readonly() }).readonly();
export type AttachmentPreparation = z.infer<typeof attachmentPreparationSchema>;
export const projectAttachmentOfferSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('ready'), scopeId: scope, path: text, writeRoot: text, planDigest: hex, preparation: attachmentPreparationSchema })]).readonly();
export type ProjectAttachmentOffer = z.infer<typeof projectAttachmentOfferSchema>;
