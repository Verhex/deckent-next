import { z } from 'zod';
import { commandEnvelopeSchema } from '#domain/core/command/index.js';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** General, sealed policy basis. Digests bind exact inputs without duplicating sensitive business data. */
export const authorityDecisionSubjectSchema = z.object({ kind: z.literal('authority-decision'), schemaVersion: z.literal(1),
  envelope: commandEnvelopeSchema, action: identitySchema, resource: z.object({ kind: identitySchema, id: identitySchema }).strict(),
  inputDigest: digest, basisDigest: digest.nullable(), policyDigest: digest,
  verdict: z.object({ decision: z.enum(['allow', 'deny', 'require-approval']), revision: identitySchema,
    reason: z.enum(['GRANTED', 'NO_GRANT', 'DENIED', 'SCOPE', 'APPROVAL_REQUIRED', 'AI_NON_DELEGABLE']), ruleId: identitySchema.optional() }).strict(),
}).strict().readonly();
export const authorityDecisionReferenceSchema = z.object({ eventId: identitySchema, sequence: counterSchema.positive() }).strict().readonly();
/** The effect pins both the immutable decision and the exact approval receipt it consumed, if required. */
export const authorityAdmissionSchema = z.object({ decision: authorityDecisionReferenceSchema,
  approval: z.object({ approvalId: identitySchema, actionDigest: digest, requestDigest: digest, commandId: identitySchema }).strict().readonly().optional(),
}).strict().readonly();
export type AuthorityDecisionSubject = z.infer<typeof authorityDecisionSubjectSchema>;
export type AuthorityAdmission = z.infer<typeof authorityAdmissionSchema>;
