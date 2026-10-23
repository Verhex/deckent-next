import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { isAiPrincipal } from '#domain/core/principal/index.js';
import { MEMORY_LIMITS, MemoryError, memoryEntrySchema, type MemoryEntry, type MemoryTombstone } from './contract.js';
import type { MemoryAutomation } from './automation.js';

/**
 * S4B-4 purge, contest resolution and staleness (S4B-DESIGN rev 4 §6.5, §6.6, A11; owner S-M10/S-M12/S-M13 2026-10-23). Pure and storage-neutral:
 * the engine computes the keyed digest, the store rewrites the rows. A purge is a person's act only; it leaves a keyed tombstone in every revision.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** The sealed record of one purge (keyed digests and ids only, never content). `invocations`: the evaluator model invocations whose stored
 * content the purge removes through `model-invocation`/`purge-content`; the record keeps them so a replay after a restore removes them again. */
export const memoryPurgeRecordSchema = z.object({ schemaVersion: z.literal(1), purgeId: identitySchema, scopeId: identitySchema, entryId: identitySchema,
  contentDigest: digest, digestKind: z.literal('keyed'), reasonCode: identitySchema, by: actor, evaluationRecordIds: z.array(identitySchema).max(MEMORY_LIMITS.purgeInvocationsMax).readonly(),
  invocationIds: z.array(identitySchema).max(MEMORY_LIMITS.purgeInvocationsMax).readonly(), atMs: counterSchema }).strict().readonly();
export type MemoryPurgeRecord = z.infer<typeof memoryPurgeRecordSchema>;
export const parseMemoryPurgeRecord = (value: unknown): MemoryPurgeRecord => {
  const parsed = memoryPurgeRecordSchema.safeParse(value);
  if (!parsed.success) throw new MemoryError('MEMORY_ENTRY_INVALID');
  return parsed.data;
};
/** The reasons a person gives on the purge card (data, rendered through the catalog). */
export const MEMORY_PURGE_REASONS = Object.freeze(['personal-data', 'poisoned', 'expired', 'other'] as const);
/** Purge, retire-by-source and contest resolution are a person's acts (A11; AI retire/purge stay floored): any AI principal is refused here too. */
export function assertMemoryPerson(actor: { readonly issuer: string; readonly subject: string; readonly assurance?: string }): void {
  if (isAiPrincipal(actor)) throw new MemoryError('MEMORY_PERSON_REQUIRED');
}
export const memoryTombstoneOf = (record: MemoryPurgeRecord): MemoryTombstone =>
  Object.freeze({ purged: true, contentDigest: record.contentDigest, digestKind: 'keyed', purgeRecordId: record.purgeId, reasonCode: record.reasonCode });
/** One revision with its content replaced by the record's tombstone (same revision, state and history; the content digest becomes the keyed one). */
export function tombstoneMemoryRevision(revision: MemoryEntry, record: MemoryPurgeRecord): MemoryEntry {
  if (revision.scopeId !== record.scopeId || revision.entryId !== record.entryId) throw new MemoryError('MEMORY_ENTRY_INVALID');
  const parsed = memoryEntrySchema.safeParse({ ...revision, content: memoryTombstoneOf(record), contentDigest: record.contentDigest });
  if (!parsed.success) throw new MemoryError('MEMORY_ENTRY_INVALID');
  return parsed.data;
}

/** S4B-4 A9 resolution: a person retires the contested (older, verified) entry, retires the new candidate, or dismisses the contest. */
export const MEMORY_CONTEST_DECISIONS = Object.freeze(['retire-contested', 'retire-candidate', 'dismiss'] as const);
export const memoryContestResolutionSchema = z.object({ schemaVersion: z.literal(1), contestId: identitySchema, scopeId: identitySchema,
  decision: z.enum(MEMORY_CONTEST_DECISIONS), by: actor, retiredEntryId: identitySchema.nullable(), atMs: counterSchema }).strict()
  .refine(value => (value.decision === 'dismiss') === (value.retiredEntryId === null)).readonly();
export type MemoryContestResolution = z.infer<typeof memoryContestResolutionSchema>;
export type MemoryContestDecision = typeof MEMORY_CONTEST_DECISIONS[number];

/**
 * §6.5 retention (owner S-M13): the retention of a system entry is the `memory-automation` row of its WorkClass family (the root class the
 * distiller recorded as the audience). No row, or a person's scope-wide entry: null (retention not known, never stale).
 */
export function memoryRetentionMs(automation: MemoryAutomation, entry: MemoryEntry): number | null {
  const family = entry.audience?.workClassFamily;
  return family ? automation.workClasses.find(row => row.workClassId === family)?.retentionProfile.entryMaxAgeMs ?? null : null;
}
/** Stale: a retention is known and the newest support (or the proposal) is older than it. A stale entry leaves model context and is listed on
 * the purge card; only a person retires or purges it. */
export function memoryEntryStale(entry: MemoryEntry, lastSupportAtMs: number | null, retentionMs: number | null, nowMs: number): boolean {
  if (retentionMs === null || entry.state === 'retired') return false;
  return nowMs - Math.max(lastSupportAtMs ?? 0, entry.provenance.proposedAtMs) > retentionMs;
}
