import { z } from 'zod';
import { persistedString, persistedUuid, identitySchema, installationIdSchema, projectIdSchema } from '#domain/core/primitives/index.js';

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
export const attachmentInventoryEntrySchema = z.strictObject({ attachment: projectAttachmentSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'active', 'revoked']) }).readonly();
export const installationRegistrationSchema = z.strictObject({ schemaVersion: z.literal(1), registrationId: persistedUuid(),
  source: installationSourceSchema, entries: z.array(attachmentInventoryEntrySchema).readonly() }).superRefine((value, ctx) => {
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
  z.strictObject({ action: z.literal('apply'), scopeId: scope, expect: hex, commandId: persistedUuid() }),
  z.strictObject({ action: z.literal('revoke'), projectId: projectIdSchema }),
]).readonly();
export type ProjectAttachmentCommand = z.infer<typeof projectAttachmentCommandSchema>;
