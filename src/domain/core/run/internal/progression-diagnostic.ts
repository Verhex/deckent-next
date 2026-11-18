import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

/** Ephemeral service observation, deliberately outside RunView and every persisted record. */
export const runProgressionDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema, revision: counterSchema,
  observedAtMs: counterSchema, validUntilMs: counterSchema,
  state: z.enum(['eligible', 'blocked', 'maintenance-only', 'unknown']), reason: identitySchema,
  actor: z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).optional(), policyRevision: identitySchema.optional(),
  actorClass: z.enum(['ai', 'person']),
  session: z.enum(['eligible', 'ineligible', 'unknown']), suspended: z.boolean(), parkUnavailable: z.boolean(),
  missing: z.array(z.strictObject({ kind: z.enum(['run', 'attempt']), id: identitySchema, action: identitySchema, scope: identitySchema,
    reason: identitySchema, code: z.enum(['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED']) })).readonly(),
}).readonly();
export type RunProgressionDiagnostic = z.infer<typeof runProgressionDiagnosticSchema>;
