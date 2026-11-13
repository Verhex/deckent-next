import { z } from 'zod';
import { counterSchema, identitySchema, persistedUuid } from '#domain/core/primitives/index.js';
import { rebindClasses } from '#domain/core/policy/index.js';
import { opaqueIdentitySchema } from './opaque-identity.js';

/** Reader-first subjects: neither application nor secondary seal producers may write them in beta.2. */
export const AUDIT_READER_ONLY_SUBJECTS: readonly string[] = Object.freeze(['access-refusal-summary', 'installation-rebind']);
export const rebindAdmissionRecordSchema = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('open-class') }),
  z.strictObject({ basis: z.literal('human-tty'), witness: opaqueIdentitySchema.nullable() }),
  z.strictObject({ basis: z.literal('macos-plain') }),
  z.strictObject({ basis: z.literal('ai-policy'), ruleId: identitySchema, policyRevision: identitySchema }),
]);
export type RebindAdmissionRecord = z.infer<typeof rebindAdmissionRecordSchema>;
export const installationRebindSubjectSchema = z.strictObject({
  kind: z.literal('installation-rebind'), schemaVersion: z.literal(1), operationId: persistedUuid(),
  part: z.enum(['source', 'target']), transition: z.enum(['keep', 'new']), phase: z.enum(['intent', 'succeeded', 'failed', 'uncertain']),
  class: z.enum(rebindClasses.classes).nullable(), admission: rebindAdmissionRecordSchema.nullable(),
  failure: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable(),
  previousInstallationId: persistedUuid(), installationId: persistedUuid(), projectId: persistedUuid().nullable(),
  previousBinding: opaqueIdentitySchema.nullable(), binding: opaqueIdentitySchema.nullable(),
  changedFields: z.array(z.enum(['bindingVersion', 'bindingStrength', 'bindingSource', 'machineDigest', 'canonicalRoot', 'device', 'inode',
    'filesystemIdentity.kind', 'filesystemIdentity.value', 'source.projectRoot', 'source.layoutRoot', 'source.bootstrapConfigPath',
    'source.layoutRevision', 'source.location', 'attachment.location'])).max(15).refine(fields => new Set(fields).size === fields.length),
  attachments: z.strictObject({ waiting: counterSchema }).nullable(),
});
