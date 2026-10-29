import { z } from 'zod';
import { identitySchema as id, counterSchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';

export const BEUSER_CONTRACT_VERSION = 1;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const competence = counterSchema.max(4);
/** Generic acceptance subject: a package, ERP record/configuration or another versioned target. */
export const acceptanceSubjectSchema = z.object({ adapter: id, version: id, evidenceRef: id, stateDigest: digest, environmentDigest: digest }).strict().readonly();
/** Only this summary reaches the walker. Persona describes behaviour, never authority. */
export const beuserWalkerSummarySchema = z.object({ schemaVersion: z.literal(1), personaId: id, journeyId: id, language: id,
  role: id, goals: z.array(id).min(1).readonly(), knowledgeBoundary: z.array(id).readonly(), accessibility: z.array(id).readonly(),
  initialKnowledge: z.array(id).readonly(), goal: id,
  competency: z.object({ computer: competence, domain: competence, product: competence }).strict().readonly(),
  preferences: z.array(id).readonly(), riskAttitude: id, surface: id, organizationContext: immutableJsonObjectSchema,
  patience: z.object({ maxSteps: counterSchema.positive(), maxWaitMs: counterSchema.positive() }).strict().readonly(), attentionMs: counterSchema.positive() }).strict().readonly();
/** Rubric stays with admission/evaluation, outside the walker model's input. */
export const beuserSealedRubricSchema = z.object({ schemaVersion: z.literal(1), journeyId: id, version: counterSchema.positive(),
  digest, parameters: immutableJsonObjectSchema }).strict().readonly();
export const beuserBindingSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  candidate: acceptanceSubjectSchema, candidateDigest: digest, personaDigest: digest, journeyDigest: digest, rubricDigest: digest,
  realmId: id, nonce: z.string().uuid(), transcriptId: id }).strict().readonly();
/** Harness authored, redacted observations; synthetic answers are never human approval evidence. */
export const beuserTranscriptEntrySchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  sequence: counterSchema.positive(), atMs: counterSchema, kind: z.enum(['screen', 'action', 'friction', 'readback', 'secret-step', 'synthetic-person-decision']),
  evidenceRef: id, digest }).strict().readonly();
export const beuserVerdictSchema = z.object({ schemaVersion: z.literal(1), binding: beuserBindingSchema, transcriptDigest: digest,
  outcome: z.enum(['GREEN', 'FRICTION', 'RED', 'unknown']), authorization: z.enum(['pass', 'fail', 'unknown']),
  safety: z.enum(['pass', 'fail', 'unknown']), experience: z.enum(['pass', 'friction', 'fail', 'unknown']),
  validity: z.enum(['valid', 'drift', 'leak', 'invalid', 'unknown']), independence: z.enum(['independent', 'reduced', 'unknown']),
  evidenceRefs: z.array(id).readonly() }).strict().readonly();
export type AcceptanceSubject = z.infer<typeof acceptanceSubjectSchema>;
export type BeuserWalkerSummary = z.infer<typeof beuserWalkerSummarySchema>;
export type BeuserSealedRubric = z.infer<typeof beuserSealedRubricSchema>;
export type BeuserBinding = z.infer<typeof beuserBindingSchema>;
export type BeuserTranscriptEntry = z.infer<typeof beuserTranscriptEntrySchema>;
export type BeuserVerdict = z.infer<typeof beuserVerdictSchema>;
