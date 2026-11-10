import { z } from 'zod';
import { commandEnvelopeSchema } from '#domain/core/command/index.js';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** General, sealed policy basis. Digests bind exact inputs without duplicating sensitive business data. */
export const authorityDecisionSubjectSchema = z.strictObject({ kind: z.literal('authority-decision'), schemaVersion: z.literal(1),
  envelope: commandEnvelopeSchema, action: identitySchema, resource: z.strictObject({ kind: identitySchema, id: identitySchema }),
  inputDigest: digest, basisDigest: digest.nullable(), policyDigest: digest,
  verdict: z.strictObject({ decision: z.enum(['allow', 'deny', 'require-approval']), revision: identitySchema,
    reason: z.enum(['GRANTED', 'NO_GRANT', 'DENIED', 'SCOPE', 'APPROVAL_REQUIRED', 'AI_NON_DELEGABLE']), ruleId: identitySchema.optional() }),
}).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const authorityDecisionReferenceSchema = z.strictObject({ eventId: identitySchema, sequence: counterSchema.positive() }).readonly();
/** The effect pins both the immutable decision and the exact approval receipt it consumed, if required. */
export const authorityAdmissionSchema = z.strictObject({ decision: authorityDecisionReferenceSchema,
  approval: z.strictObject({ approvalId: identitySchema, actionDigest: digest, requestDigest: digest, commandId: identitySchema }).readonly().optional(),
}).readonly();
export type AuthorityDecisionSubject = z.infer<typeof authorityDecisionSubjectSchema>;
export type AuthorityAdmission = z.infer<typeof authorityAdmissionSchema>;
