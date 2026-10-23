import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import limits from './limits.json' with { type: 'json' };

/**
 * Memory journal (S4 v1; S4B-1 v2 adds `audience`; K-D, M5 design note §3): curated knowledge and lessons of exactly one scope. Content is immutable after the proposal; a
 * change is a new entry plus the old one retired with `supersededBy`. States move candidate → verified → retired only; there is no delete.
 * The contract is storage-neutral: every field is plain JSON, so any adapter (SQLite in Core, another database in Enterprise) stores it unchanged.
 */
export const MEMORY_SCHEMA_VERSION = 2;
/** Bounds are protocol data (`limits.json`), never configurable policy and never literals in code. */
export const MEMORY_LIMITS = Object.freeze({ ...limits });
export const MEMORY_STATES = Object.freeze(['candidate', 'verified', 'retired'] as const);
export const MEMORY_KINDS = Object.freeze(['fact', 'lesson'] as const);
export const MEMORY_ORIGINS = Object.freeze(['human', 'run', 'model', 'import'] as const);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (max: number) => z.string().min(1).refine(value => value.trim() === value && bytes(value) <= max);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
export const memoryLessonSchema = z.object({ source: text(limits.lessonFieldMaxBytes), cause: text(limits.lessonFieldMaxBytes),
  correction: text(limits.lessonFieldMaxBytes), evidence: text(limits.lessonFieldMaxBytes) }).strict().readonly();
export const memoryContentSchema = z.object({ kind: z.enum(MEMORY_KINDS), title: text(limits.titleMaxBytes), body: text(limits.bodyMaxBytes),
  tags: z.array(text(limits.tagMaxBytes)).max(limits.tagsMax).readonly(), lesson: memoryLessonSchema.nullable() }).strict()
  .refine(value => (value.kind === 'lesson') === (value.lesson !== null) && new Set(value.tags).size === value.tags.length).readonly();
/** S4B-1 entry v2 (§4.3): who a system entry may serve inside its scope — the source Task's WorkClass family (root of the parent chain) and the
 * Run's work target (`null`: a Run without one). A person's entry has `audience: null` (scope-wide, as authored). */
export const memoryAudienceSchema = z.object({ workClassFamily: identitySchema, workTargetId: identitySchema.nullable() }).strict().readonly();
/** S4B-1 (§4.4): one worker `lessons` claim (S4B-2 carries it in the final report). Claims only; a lesson needs its cause and correction. */
export const memoryLessonClaimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fact'), title: text(limits.titleMaxBytes), body: text(limits.bodyMaxBytes) }).strict(),
  z.object({ kind: z.literal('lesson'), title: text(limits.titleMaxBytes), body: text(limits.bodyMaxBytes), cause: text(limits.lessonFieldMaxBytes),
    correction: text(limits.lessonFieldMaxBytes) }).strict(),
]);
/** S4B-4 (§6.6, A11, owner S-M12): what a purge leaves of an entry's content in every revision — the keyed content digest (it blocks a
 * re-proposal and reveals nothing), the purge record id and its reason code. No title, body, tag or lesson field survives. */
export const memoryTombstoneSchema = z.object({ purged: z.literal(true), contentDigest: digest, digestKind: z.literal('keyed'), purgeRecordId: identitySchema,
  reasonCode: identitySchema }).strict().readonly();
export const memoryOriginSchema = z.object({ kind: z.enum(MEMORY_ORIGINS), ref: text(limits.originRefMaxBytes).nullable() }).strict().readonly();
/** A reference to an evaluation record the engine resolves through its port (task evaluation, auditor verdict, ...): kind + id + digest. */
export const memoryEvaluationRefSchema = z.object({ kind: identitySchema, id: identitySchema, digest }).strict().readonly();
export const memoryVerificationBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human-review'), note: text(limits.noteMaxBytes) }).strict(),
  z.object({ kind: z.literal('independent-evaluation'), record: memoryEvaluationRefSchema }).strict(),
]);
const verificationSchema = z.discriminatedUnion('basis', [
  z.object({ basis: z.literal('human-review'), reviewer: actor, note: z.string(), verifiedAtMs: counterSchema }).strict(),
  z.object({ basis: z.literal('independent-evaluation'), evaluator: actor, record: memoryEvaluationRefSchema, verifiedAtMs: counterSchema }).strict(),
]);
export const memoryEntrySchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(MEMORY_SCHEMA_VERSION)]), scopeId: identitySchema, entryId: identitySchema,
  revision: counterSchema.positive(), state: z.enum(MEMORY_STATES), content: z.union([memoryContentSchema, memoryTombstoneSchema]), contentDigest: digest,
  provenance: z.object({ author: z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly(), origin: memoryOriginSchema,
    proposedAtMs: counterSchema, commandId: identitySchema }).strict().readonly(),
  verification: verificationSchema.nullable(),
  retirement: z.object({ by: z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly(), reason: z.string().min(1),
    supersededBy: identitySchema.nullable(), retiredAtMs: counterSchema }).strict().readonly().nullable(),
  updatedAtMs: counterSchema,
  /** v2 only (a v1 row has no such key and is read unchanged). */
  audience: memoryAudienceSchema.nullable().optional(),
}).strict().superRefine((entry, context) => {
  if ((entry.schemaVersion === 1) !== (entry.audience === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'MEMORY_ENTRY_INVALID' });
  const consistent = entry.state === 'candidate' ? entry.verification === null && entry.retirement === null
    : entry.state === 'verified' ? entry.verification !== null && entry.retirement === null : entry.retirement !== null;
  if (!consistent || entry.retirement?.supersededBy === entry.entryId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'MEMORY_ENTRY_INVALID' });
  if ('purged' in entry.content && entry.content.contentDigest !== entry.contentDigest) context.addIssue({ code: z.ZodIssueCode.custom, message: 'MEMORY_ENTRY_INVALID' });
}).readonly();
export type MemoryContent = z.infer<typeof memoryContentSchema>;
export type MemoryTombstone = z.infer<typeof memoryTombstoneSchema>;
/** Whether an entry's content was purged (only the tombstone is left). */
export const isMemoryTombstone = (content: MemoryContent | MemoryTombstone): content is MemoryTombstone => 'purged' in content;
export type MemoryAudience = z.infer<typeof memoryAudienceSchema>;
export type MemoryLessonClaim = z.infer<typeof memoryLessonClaimSchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryEvaluationRef = z.infer<typeof memoryEvaluationRefSchema>;
export type MemoryVerificationBasis = z.infer<typeof memoryVerificationBasisSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryState = MemoryEntry['state'];
/** An evaluation the engine resolved for an `independent-evaluation` basis: who evaluated, the verdict and the content digest it judged; S4B-3:
 * its mode (a `shadow` record is never a basis) and the models it names (the evaluator's, and the source models it judged independent of). */
export interface MemoryResolvedEvaluation { readonly record: MemoryEvaluationRef; readonly evaluator: { readonly issuer: string; readonly subject: string };
  readonly verdict: 'pass' | 'fail' | 'unknown'; readonly subjectDigest: string; readonly mode: 'shadow' | 'live';
  readonly evaluatorModel: { readonly channelId: string; readonly modelId: string; readonly maker: string | null };
  readonly sourceModels: readonly { readonly channelId: string; readonly modelId: string; readonly maker: string | null }[] }
export type MemoryErrorCode = 'MEMORY_ENTRY_INVALID' | 'MEMORY_TRANSITION_INVALID' | 'MEMORY_VERIFIER_NOT_HUMAN' | 'MEMORY_SELF_VERIFICATION'
  | 'MEMORY_EVALUATION_UNAVAILABLE' | 'MEMORY_EVALUATION_NOT_PASSED' | 'MEMORY_EVALUATION_OTHER_CONTENT' | 'MEMORY_QUERY_INVALID' | 'MEMORY_AUTOMATION_INVALID'
  | 'MEMORY_EVALUATION_NOT_INDEPENDENT' | 'MEMORY_EVALUATION_MAKER_UNKNOWN' | 'MEMORY_EVALUATOR_REQUIRED' | 'MEMORY_PERSON_REQUIRED';
export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode) { super(code); this.name = 'MemoryError'; }
}
