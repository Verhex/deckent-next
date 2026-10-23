import { z } from 'zod';
import { clientCommandIdSchema, identitySchema, counterSchema, memoryContentSchema, memoryOriginSchema, memoryVerificationBasisSchema, MEMORY_LIMITS, MEMORY_STATES,
  type AuditEvent, type MemoryEntry, type MemoryEvaluationRef, type MemoryResolvedEvaluation, type MemoryState, type VerifiedPrincipal } from '#domain/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';

const scoped = { schemaVersion: z.literal(1), scopeId: identitySchema };
const states = z.array(z.enum(MEMORY_STATES)).min(1).max(MEMORY_STATES.length).readonly().optional();
const limit = z.number().int().min(1).max(MEMORY_LIMITS.pageMax);
export const memoryProposeCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, content: memoryContentSchema, origin: memoryOriginSchema }).strict();
export const memoryVerifyCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, entryId: identitySchema, expectedRevision: counterSchema.positive(),
  basis: memoryVerificationBasisSchema }).strict();
export const memoryRetireCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, entryId: identitySchema, expectedRevision: counterSchema.positive(),
  reason: z.string().min(1), supersededBy: identitySchema.nullable() }).strict();
export const memoryInspectQuerySchema = z.object({ ...scoped, entryId: identitySchema }).strict();
/** Default states: candidate and verified (retired entries are shown only when asked for). */
export const memoryListQuerySchema = z.object({ ...scoped, states, limit }).strict();
export const memorySearchQuerySchema = z.object({ ...scoped, query: z.string(), states, limit }).strict();
export type MemoryProposeCommand = z.infer<typeof memoryProposeCommandSchema>;
export type MemoryVerifyCommand = z.infer<typeof memoryVerifyCommandSchema>;
export type MemoryRetireCommand = z.infer<typeof memoryRetireCommandSchema>;
export type MemoryInspectQuery = z.infer<typeof memoryInspectQuerySchema>;
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;
export type MemorySearchQuery = z.infer<typeof memorySearchQuerySchema>;

/** A read that could not be completed holds: the caller never receives an empty memory in place of a failed read (K-D, design note §3). */
export type MemoryHoldCode = 'MEMORY_UNAVAILABLE' | 'MEMORY_CORRUPT';
export interface MemoryHeld { readonly schemaVersion: 1; readonly status: 'held'; readonly code: MemoryHoldCode }
export type MemoryInspection = { readonly schemaVersion: 1; readonly status: 'ok'; readonly entry: MemoryEntry; readonly history: readonly MemoryEntry[] }
  | { readonly schemaVersion: 1; readonly status: 'not-found'; readonly entryId: string } | MemoryHeld;
export type MemoryListing = { readonly schemaVersion: 1; readonly status: 'ok'; readonly scopeId: string; readonly entries: readonly MemoryEntry[] } | MemoryHeld;
/** `method` names what answered: the store's full-text index, or the bounded scan of the newest `scanMax` entries (`complete` false when more exist). */
export type MemorySearchResult = { readonly schemaVersion: 1; readonly status: 'ok'; readonly scopeId: string; readonly terms: readonly string[];
  readonly method: 'full-text' | 'scan'; readonly complete: boolean; readonly entries: readonly MemoryEntry[] } | MemoryHeld;
export interface MemoryMutationResult { readonly schemaVersion: 1; readonly replayed: boolean; readonly entry: MemoryEntry }

/** Idempotency record of one command: the fingerprint of (command, principal) and the revision it produced. */
export interface MemoryReceipt { readonly scopeId: string; readonly commandId: string; readonly entryId: string; readonly revision: number; readonly digest: string }
/** One transition. The store applies it atomically: receipt replay (same digest) or conflict, then compare-and-set on `previous`, then write the
 * new revision, keep every earlier revision, record the receipt and the audit event, and refresh its search index. */
export interface MemoryChange { readonly previous: MemoryEntry | null; readonly next: MemoryEntry; readonly receipt: MemoryReceipt; readonly event: AuditEvent }
/**
 * DB-neutral journal port. Values are domain JSON; no SQL, cursor or driver type crosses it. Full-text search is a declared capability: a store
 * that has it answers `search` with entry ids (best first, in-scope only); one that does not (or lacks the method) gets the engine's bounded scan.
 * Reads throw `MemoryJournalError('MEMORY_CORRUPT')` on any integrity failure and never return a partial row.
 */
export interface MemoryJournalStore {
  readonly capabilities: { readonly fullTextSearch: boolean };
  load(scopeId: string, entryId: string): Promise<MemoryEntry | null>;
  loadRevision(scopeId: string, entryId: string, revision: number): Promise<MemoryEntry | null>;
  /** The newest `limit` revisions of one entry, oldest first. */
  history(scopeId: string, entryId: string, limit: number): Promise<readonly MemoryEntry[]>;
  /** Current entries of the scope in the given states, most recently changed first, at most `limit` (an index-backed bounded read). */
  list(scopeId: string, states: readonly MemoryState[], limit: number): Promise<readonly MemoryEntry[]>;
  search?(scopeId: string, terms: readonly string[], states: readonly MemoryState[], limit: number): Promise<readonly string[]>;
  receipt(scopeId: string, commandId: string): Promise<MemoryReceipt | null>;
  commit(change: MemoryChange): Promise<{ readonly replayed: boolean; readonly entry: MemoryEntry }>;
  close(): void;
}
export type MemoryAction = 'inspect' | 'propose' | 'verify' | 'retire';
export interface MemoryJournalDependencies {
  readonly verifier: PrincipalVerifier;
  readonly authorize: (action: MemoryAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  readonly openStore: (access: 'read' | 'write') => Promise<MemoryJournalStore>;
  /** Resolves an evaluation record for an `independent-evaluation` basis; absent (Core v1 default) or null: the basis fails closed. */
  readonly resolveEvaluation?: (scopeId: string, record: MemoryEvaluationRef) => Promise<MemoryResolvedEvaluation | null>;
  readonly now: () => number;
  readonly eventId: () => string;
}
export type MemoryJournalErrorCode = MemoryHoldCode | 'MEMORY_COMMAND_CONFLICT' | 'MEMORY_REVISION_CONFLICT' | 'MEMORY_NOT_FOUND' | 'MEMORY_OUTCOME_UNKNOWN';
export class MemoryJournalError extends Error {
  constructor(readonly code: MemoryJournalErrorCode) { super(code); this.name = 'MemoryJournalError'; }
}
