import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import limits from './limits.json' with { type: 'json' };

/**
 * Memory journal v1 (S4; K-D, M5 design note §3): curated knowledge and lessons of exactly one scope. Content is immutable after the proposal; a
 * change is a new entry plus the old one retired with `supersededBy`. States move candidate → verified → retired only; there is no delete.
 * The contract is storage-neutral: every field is plain JSON, so any adapter (SQLite in Core, another database in Enterprise) stores it unchanged.
 */
export const MEMORY_SCHEMA_VERSION = 1;
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
export const memoryEntrySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, entryId: identitySchema,
  revision: counterSchema.positive(), state: z.enum(MEMORY_STATES), content: memoryContentSchema, contentDigest: digest,
  provenance: z.object({ author: z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly(), origin: memoryOriginSchema,
    proposedAtMs: counterSchema, commandId: identitySchema }).strict().readonly(),
  verification: verificationSchema.nullable(),
  retirement: z.object({ by: z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly(), reason: z.string().min(1),
    supersededBy: identitySchema.nullable(), retiredAtMs: counterSchema }).strict().readonly().nullable(),
  updatedAtMs: counterSchema,
}).strict().superRefine((entry, context) => {
  const consistent = entry.state === 'candidate' ? entry.verification === null && entry.retirement === null
    : entry.state === 'verified' ? entry.verification !== null && entry.retirement === null : entry.retirement !== null;
  if (!consistent || entry.retirement?.supersededBy === entry.entryId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'MEMORY_ENTRY_INVALID' });
}).readonly();
export type MemoryContent = z.infer<typeof memoryContentSchema>;
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;
export type MemoryEvaluationRef = z.infer<typeof memoryEvaluationRefSchema>;
export type MemoryVerificationBasis = z.infer<typeof memoryVerificationBasisSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryState = MemoryEntry['state'];
/** An evaluation the engine resolved for an `independent-evaluation` basis: who evaluated, the verdict and the content digest it judged. */
export interface MemoryResolvedEvaluation { readonly record: MemoryEvaluationRef; readonly evaluator: { readonly issuer: string; readonly subject: string };
  readonly verdict: 'pass' | 'fail' | 'unknown'; readonly subjectDigest: string }
export type MemoryErrorCode = 'MEMORY_ENTRY_INVALID' | 'MEMORY_TRANSITION_INVALID' | 'MEMORY_VERIFIER_NOT_HUMAN' | 'MEMORY_SELF_VERIFICATION'
  | 'MEMORY_EVALUATION_UNAVAILABLE' | 'MEMORY_EVALUATION_NOT_PASSED' | 'MEMORY_EVALUATION_OTHER_CONTENT' | 'MEMORY_QUERY_INVALID';
export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode) { super(code); this.name = 'MemoryError'; }
}
