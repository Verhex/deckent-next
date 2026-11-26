import { z } from 'zod';
import { counterSchema, identitySchema, persistedUuid } from '#domain/core/primitives/index.js';
import { rebindClasses } from '#domain/core/policy/index.js';
import { opaqueIdentitySchema } from './opaque-identity.js';
import type { AuditSubject } from './contract.js';

const LOCAL_REFUSAL_BASES = [
  'fetch-address-policy', 'fetch-redirect-policy', 'fetch-preflight-policy', 'workspace-read-guard',
  'agent-tool-policy', 'tool-approval', 'tool-offer', 'mcp-send-trust', 'retained-response-authority', 'workspace-edit-guard', 'shell-local-guard',
  'model-ingress-quarantine', 'shell-write-set', 'pre-effect-evidence', 'native-request-replay', 'native-item-reservation',
] as const;
export type LocalRefusalBasis = typeof LOCAL_REFUSAL_BASES[number];
/** The one CLI-reported pair: a verified Native CLI's own permission-denial report (the CLI reported it; deckent did not decide it). */
export type CliReportedRefusalBasis = 'cli-permission-denial';
const localRefusalBases: ReadonlySet<string> = new Set(LOCAL_REFUSAL_BASES), cliReportedBasis: CliReportedRefusalBasis = 'cli-permission-denial';

/** Writer admission only. Older readers can still verify all frozen v1 subjects. */
export function canWriteAuditSubject(subject: AuditSubject): boolean {
  if (subject.kind === 'installation-rebind') return false;
  return subject.kind !== 'access-refusal-summary'
    || subject.decisionSource === 'deckent-decision' && localRefusalBases.has(subject.evidenceBasis)
    || subject.decisionSource === 'cli-reported' && subject.evidenceBasis === cliReportedBasis;
}
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
