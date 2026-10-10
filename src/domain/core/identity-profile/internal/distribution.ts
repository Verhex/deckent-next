import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { effectCommandSchema } from '#domain/core/effect/index.js';
import { policyChangeSchema } from '#domain/core/policy/index.js';
import { identityProfileRefSchema, identityProfileJsonSchema } from './schema.js';

/** Selections refer to catalog entries; no principal, permission, role definition or persona can be authored here. */
export const identityDistributionSelectionSchema = identityProfileJsonSchema.pipe(z.object({ schemaVersion: z.literal(1),
  profile: identityProfileRefSchema, scopeId: identitySchema,
  assignments: z.array(z.object({ principalId: identitySchema, roleId: identitySchema,
    scopeIds: z.array(identitySchema).min(1).max(128).readonly() }).strict().readonly()).max(32).readonly(),
  removeBindingIds: z.array(identitySchema).max(32).readonly(),
}).strict().readonly());
export type IdentityDistributionSelection = z.infer<typeof identityDistributionSelectionSchema>;
/** Retain this exact envelope to replay its C11 command, including after settlement or process restart. */
export const identityDistributionSubmissionSchema = identityProfileJsonSchema.pipe(z.object({ schemaVersion: z.literal(1),
  selection: identityDistributionSelectionSchema, registryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly(), command: effectCommandSchema,
}).strict().superRefine((value, ctx) => {
  const change = policyChangeSchema.safeParse(value.command.input), command = value.command;
  if (!change.success || change.data.schemaVersion !== 2 || change.data.profile.id !== value.selection.profile.id
    || change.data.profile.version !== value.selection.profile.version || change.data.profile.registryDigest !== value.registryDigest
    || change.data.profile.previewDigest !== value.previewDigest || command.scopeId !== value.selection.scopeId
    || command.operation.id !== 'policy.administer' || command.operation.version !== 1 || command.target.kind !== 'authority-document'
    || command.target.id !== 'installation' || command.idempotencyKey !== command.commandId || !command.expectedVersion) {
    ctx.addIssue({ code: 'custom', message: 'IDENTITY_PREVIEW_INVALID' });
  }
}).readonly());
export type IdentityDistributionSubmission = z.infer<typeof identityDistributionSubmissionSchema>;
