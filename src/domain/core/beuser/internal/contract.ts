import { persistedUuid, identitySchema as id, counterSchema, immutableJsonObjectSchema } from '#domain/core/primitives/index.js';
import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export const BEUSER_CONTRACT_VERSION = 2;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const competence = counterSchema.max(4);
/** Package adapter pin; the complete inventory stays in the candidate, outside bounded execution JSON. */
export const beuserCandidateManifestSchema = z.strictObject({ sha256: digest, fileCount: counterSchema.positive(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u), sourceTreeSha256: digest, version: id }).readonly();
export type BeuserCandidateManifest = z.infer<typeof beuserCandidateManifestSchema>;
/** Generic acceptance subject: a package, ERP record/configuration or another versioned target. */
export const acceptanceSubjectSchema = z.strictObject({ adapter: id, version: id, evidenceRef: id, stateDigest: digest, environmentDigest: digest }).readonly();
/** Only this summary reaches the walker. Persona describes behaviour, never authority. */
export const beuserWalkerSummarySchema = z.strictObject({ schemaVersion: z.literal(1), personaId: id, journeyId: id, language: id,
  role: id, goals: z.array(id).min(1).readonly(), knowledgeBoundary: z.array(id).readonly(), accessibility: z.array(id).readonly(),
  initialKnowledge: z.array(id).readonly(), goal: id,
  competency: z.strictObject({ computer: competence, domain: competence, product: competence }).readonly(),
  preferences: z.array(id).readonly(), riskAttitude: id, surface: id, organizationContext: immutableJsonObjectSchema,
  patience: z.strictObject({ maxSteps: counterSchema.positive(), maxWaitMs: counterSchema.positive() }).readonly(), attentionMs: counterSchema.positive() }).readonly();
/** Rubric stays with admission/evaluation, outside the walker model's input. */
export const beuserSealedRubricSchema = z.strictObject({ schemaVersion: z.literal(1), journeyId: id, version: counterSchema.positive(),
  digest, parameters: immutableJsonObjectSchema }).readonly();
export const beuserBindingSchema = z.strictObject({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  candidate: acceptanceSubjectSchema, candidateDigest: digest, personaDigest: digest, journeyDigest: digest, rubricDigest: digest,
  realmId: id, nonce: persistedUuid(), transcriptId: id }).readonly();
/** Harness authored, redacted observations; synthetic answers are never human approval evidence. v2: `arrange` is trusted start-state setup, never a persona action. */
export const beuserTranscriptEntrySchema = z.strictObject({ schemaVersion: z.literal(1), binding: beuserBindingSchema,
  sequence: counterSchema.positive(), atMs: counterSchema, kind: z.enum(['arrange', 'screen', 'action', 'friction', 'readback', 'secret-step', 'synthetic-person-decision']),
  evidenceRef: id, digest }).readonly();
export const beuserVerdictSchema = z.strictObject({ schemaVersion: z.literal(1), binding: beuserBindingSchema, transcriptDigest: digest,
  outcome: z.enum(['GREEN', 'FRICTION', 'RED', 'unknown']), authorization: z.enum(['pass', 'fail', 'unknown']),
  safety: z.enum(['pass', 'fail', 'unknown']), experience: z.enum(['pass', 'friction', 'fail', 'unknown']),
  validity: z.enum(['valid', 'drift', 'leak', 'invalid', 'unknown']), independence: z.enum(['independent', 'reduced', 'unknown']),
  evidenceRefs: z.array(id).readonly() }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type AcceptanceSubject = z.infer<typeof acceptanceSubjectSchema>;
export type BeuserWalkerSummary = z.infer<typeof beuserWalkerSummarySchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type BeuserSealedRubric = z.infer<typeof beuserSealedRubricSchema>;
export type BeuserBinding = z.infer<typeof beuserBindingSchema>;
export type BeuserTranscriptEntry = z.infer<typeof beuserTranscriptEntrySchema>;
export type BeuserVerdict = z.infer<typeof beuserVerdictSchema>;
