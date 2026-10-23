import { z } from 'zod';
import { clientCommandIdSchema, identitySchema, counterSchema, memoryAudienceSchema, memoryContentSchema, memoryOriginSchema, memoryVerificationBasisSchema, MEMORY_LIMITS, MEMORY_STATES,
  type AuditEvent, type MemoryContest, type MemoryEntry, type MemoryEvaluationRecord, type MemoryEvaluationRef, type MemoryModelRef, type MemoryResolvedEvaluation, type MemoryState,
  type VerifiedPrincipal } from '#domain/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';

const scoped = { schemaVersion: z.literal(1), scopeId: identitySchema };
const states = z.array(z.enum(MEMORY_STATES)).min(1).max(MEMORY_STATES.length).readonly().optional();
const limit = z.number().int().min(1).max(MEMORY_LIMITS.pageMax);
export const memoryProposeCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, content: memoryContentSchema, origin: memoryOriginSchema }).strict();
export const memoryVerifyCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, entryId: identitySchema, expectedRevision: counterSchema.positive(),
  basis: memoryVerificationBasisSchema }).strict();
export const memoryRetireCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, entryId: identitySchema, expectedRevision: counterSchema.positive(),
  reason: z.string().min(1), supersededBy: identitySchema.nullable() }).strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const attemptRefSchema = z.object({ runId: identitySchema, taskId: identitySchema, attemptId: identitySchema }).strict().readonly();
/** S4B-1 (§4.3): one system candidate from one sealed source (the distiller only). Its id and support row are derived, never client-chosen. */
export const memoryExtractCommandSchema = z.object({ ...scoped, source: attemptRefSchema, ruleId: identitySchema, ruleVersion: counterSchema.positive(), claimIndex: counterSchema,
  content: memoryContentSchema, audience: memoryAudienceSchema, support: z.object({ producer: z.enum(['rule', 'worker-claim']), evaluationId: identitySchema,
    evaluationDigest: digestSchema, reportDigest: digestSchema.nullable() }).strict().readonly() }).strict();
export type MemoryExtractCommand = z.infer<typeof memoryExtractCommandSchema>;
/** One piece of evidence behind a system entry (append-only; `supportId` = the extraction command id, so a replay adds nothing). Never read for
 * model independence: S4B-3 re-derives the worker model from the sealed Run. */
export interface MemorySupport { readonly schemaVersion: 1; readonly scopeId: string; readonly entryId: string; readonly supportId: string; readonly producer: 'rule' | 'worker-claim';
  readonly source: { readonly runId: string; readonly taskId: string; readonly attemptId: string }; readonly ruleId: string; readonly ruleVersion: number;
  readonly evaluationId: string; readonly evaluationDigest: string; readonly reportDigest: string | null; readonly atMs: number }
/** The durable once-per-Attempt extraction record (bounds count `proposed`; `shadow` counts candidates a shadow run computed without writing). */
export interface MemoryExtractionReceipt { readonly schemaVersion: 1; readonly scopeId: string; readonly source: { readonly runId: string; readonly taskId: string; readonly attemptId: string };
  readonly atMs: number; readonly proposed: number; readonly shadow: number; readonly mode: 'live' | 'shadow';
  readonly refused: readonly { readonly ruleId: string; readonly claimIndex: number; readonly code: string }[]; readonly registryRevision: string }
export type MemoryAlertKey = 'memory.alert.extractionBound' | 'memory.alert.screening';
export type MemoryDistilOutcome = { readonly schemaVersion: 1; readonly status: 'extracted'; readonly proposed: number; readonly supported: number; readonly shadow: number;
  readonly refused: MemoryExtractionReceipt['refused']; readonly alerts: readonly { readonly key: MemoryAlertKey; readonly scopeId: string; readonly count: number }[] }
  | { readonly schemaVersion: 1; readonly status: 'replayed'; readonly receipt: MemoryExtractionReceipt }
  | { readonly schemaVersion: 1; readonly status: 'skipped'; readonly reason: 'work-class' | 'not-accepted' };
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
/** `withheld` (S4B-1 §7.4): system entries in the answer the caller may not see (no source Attempt it may read, or a work target it may not use);
 * only the count is given, never their ids, titles or digests. */
export type MemoryListing = { readonly schemaVersion: 1; readonly status: 'ok'; readonly scopeId: string; readonly entries: readonly MemoryEntry[]; readonly withheld: number } | MemoryHeld;
/** `method` names what answered: the store's full-text index, or the bounded scan of the newest `scanMax` entries (`complete` false when more exist). */
export type MemorySearchResult = { readonly schemaVersion: 1; readonly status: 'ok'; readonly scopeId: string; readonly terms: readonly string[];
  readonly method: 'full-text' | 'scan'; readonly complete: boolean; readonly entries: readonly MemoryEntry[]; readonly withheld: number } | MemoryHeld;
export interface MemoryMutationResult { readonly schemaVersion: 1; readonly replayed: boolean; readonly entry: MemoryEntry }

/** Idempotency record of one command: the fingerprint of (command, principal) and the revision it produced. */
export interface MemoryReceipt { readonly scopeId: string; readonly commandId: string; readonly entryId: string; readonly revision: number; readonly digest: string }
/** One transition. The store applies it atomically: receipt replay (same digest) or conflict, then compare-and-set on `previous`, then write the
 * new revision, keep every earlier revision, record the receipt and the audit event, and refresh its search index. */
export interface MemoryChange { readonly previous: MemoryEntry | null; readonly next: MemoryEntry; readonly receipt: MemoryReceipt; readonly event: AuditEvent;
  /** S4B-1: a system candidate's first support row, written in the same atomic commit. */ readonly support?: MemorySupport }
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
  /** S4B-1 (§12), DB-neutral like the rest; a store without them fails closed (no system entry, every system entry withheld). Support rows oldest first. */
  appendSupport?(support: MemorySupport): Promise<{ readonly replayed: boolean }>;
  listSupport?(scopeId: string, entryId: string, limit: number): Promise<readonly MemorySupport[]>;
  /** Whether purged content with this keyed digest exists in the scope (S4B-4 writes purge records). */
  findTombstone?(scopeId: string, contentDigest: string): Promise<boolean>;
  extractionReceipt?(scopeId: string, source: MemorySupport['source']): Promise<MemoryExtractionReceipt | null>;
  recordExtraction?(receipt: MemoryExtractionReceipt): Promise<{ readonly replayed: boolean }>;
  /** Candidates written for the Run, and for the scope since `sinceMs` (the bound window). */
  extractionCounts?(scopeId: string, runId: string, sinceMs: number): Promise<{ readonly run: number; readonly scope: number }>;
  extractionCursor?(scopeId: string): Promise<string | null>;
  advanceCursor?(scopeId: string, cursor: string): Promise<void>;
  /** S4B-3 (§6.1, §12): a sealed evaluation record with its audit event in one commit (same id + digest replays; another digest conflicts). */
  putEvaluation?(record: MemoryEvaluationRecord, digest: string, event: AuditEvent): Promise<{ readonly replayed: boolean }>;
  loadEvaluation?(scopeId: string, recordId: string): Promise<{ readonly record: MemoryEvaluationRecord; readonly digest: string } | null>;
  /** The newest `limit` records of the scope, newest first (the daily caps read only today's of them). */
  recentEvaluations?(scopeId: string, limit: number): Promise<readonly MemoryEvaluationRecord[]>;
  /** S4B-3 A9: an open contest with its audit event (append-only; S4B-4 resolves it once). */
  openContest?(contest: MemoryContest, event: AuditEvent): Promise<{ readonly replayed: boolean }>;
  contestCount?(scopeId: string, sinceMs: number): Promise<number>;
  close(): void;
}
export type MemoryAction = 'inspect' | 'propose' | 'verify' | 'retire' | 'contest';
/** A pure policy view over one loaded document for the read filter: whether the caller may take `action` on `resource`. */
export type MemoryReadFilter = (resource: { readonly kind: string; readonly id: string }, action: string) => boolean;
export interface MemoryJournalDependencies {
  readonly verifier: PrincipalVerifier;
  readonly authorize: (action: MemoryAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  readonly openStore: (access: 'read' | 'write') => Promise<MemoryJournalStore>;
  /** Resolves an evaluation record for an `independent-evaluation` basis; absent (Core v1 default) or null: the basis fails closed. */
  readonly resolveEvaluation?: (scopeId: string, record: MemoryEvaluationRef) => Promise<MemoryResolvedEvaluation | null>;
  /** S4B-1 §4.6: HMAC with the installation's memory digest key over a labelled canonical value (content digests, system ids, receipts). */
  readonly keyedDigest: (label: string, value: unknown) => string;
  /** S4B-1 §7.4: the caller's policy view for the source filter; absent, every system-derived entry is withheld (fail closed). */
  readonly readFilter?: (principal: VerifiedPrincipal, scopeId: string) => Promise<MemoryReadFilter>;
  /** The protected `memory.automation` overlay (narrowing only); absent, the Core seed. */
  readonly automation?: unknown;
  /** Known secrets for candidate screening (§4.5); pattern secrets are refused without it too. */
  readonly knownSecrets?: KnownSecretSnapshot;
  /** S4B-3 §6.3: the sealed sources of an entry's support rows; verify re-derives the source worker models through it (absent: independence fails closed). */
  readonly evaluationSources?: MemoryEvaluationSources;
  readonly now: () => number;
  readonly eventId: () => string;
}
/** One sealed source as the evaluator reads it (built from the Run snapshot, the canonical evaluation and the effect ledger; never raw worker output). */
export interface MemoryEvaluationSource { readonly accepted: boolean; readonly settled: boolean; readonly evaluationId: string;
  readonly criteria: readonly { readonly criterionId: string; readonly status: string }[];
  /** The worker models of the Attempt re-derived from the sealed Run (assignment or pin, auxiliary models, the evaluation's reported names), with makers. */
  readonly models: readonly MemoryModelRef[] }
export interface MemoryEvaluationSources {
  /** null: the Run or its evaluation is gone (the entry then has no provable source and is never evaluated or verified). */
  source(scopeId: string, attempt: MemorySupport['source']): Promise<MemoryEvaluationSource | null>;
}
/** One model the evaluator may use in the scope: an active `memory-evaluator` role row with its canonical maker and channel billing. `invocable`:
 * an invocation path exists for it in this installation (a row without one is never selected). */
export interface MemoryEvaluatorRow { readonly channelId: string; readonly modelId: string; readonly maker: string | null;
  readonly billing: 'subscription' | 'local' | 'metered' | null; readonly invocable: boolean }
export type MemoryEvaluatorCall = { readonly status: 'responded'; readonly text: string; readonly invocationId: string | null; readonly spend: MemoryEvaluationRecord['spend'] }
  | { readonly status: 'failed'; readonly code: string; readonly invocationId: string | null; readonly spend: MemoryEvaluationRecord['spend'] };
export interface MemoryEvaluatorPorts {
  /** The scope's evaluator rows (S2 role registry × catalog), registry order. */
  rows(scopeId: string): Promise<readonly MemoryEvaluatorRow[]>;
  /** One call, no tools, no retry. Throws only when nothing was sent (a refusal before the provider effect: the pass stops, no record, the
   * candidate is asked later); every failure after the claim is `failed` with the spend the ledger settled (sealed, never asked again). */
  invoke(request: { readonly scopeId: string; readonly commandId: string; readonly row: MemoryEvaluatorRow; readonly maxCompletionTokens: number;
    readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[] }): Promise<MemoryEvaluatorCall>;
}
export type MemoryEvaluationAlertKey = 'memory.alert.evaluationDailyCap' | 'memory.alert.spendCap' | 'memory.alert.evaluatorBreaker' | 'memory.alert.contestBound';
export type MemoryEvaluationSkip = 'not-system' | 'source-not-accepted' | 'maker-unknown' | 'no-independent-evaluator' | 'evaluated';
export interface MemoryEvaluationPass { readonly schemaVersion: 1; readonly mode: 'shadow' | 'live'; readonly calls: number;
  readonly records: readonly { readonly entryId: string; readonly recordId: string; readonly verdict: MemoryEvaluationRecord['verdict']; readonly verified: boolean; readonly contests: number }[];
  readonly skipped: readonly { readonly entryId: string; readonly reason: MemoryEvaluationSkip }[];
  readonly alerts: readonly { readonly key: MemoryEvaluationAlertKey; readonly scopeId: string }[] }
export type MemoryJournalErrorCode = MemoryHoldCode | 'MEMORY_COMMAND_CONFLICT' | 'MEMORY_REVISION_CONFLICT' | 'MEMORY_NOT_FOUND' | 'MEMORY_OUTCOME_UNKNOWN'
  | 'MEMORY_ENTRY_WITHHELD' | 'MEMORY_PURGED_CONTENT' | 'MEMORY_EXTRACTION_BOUND' | 'MEMORY_CANDIDATE_SECRET' | 'MEMORY_CANDIDATE_QUARANTINED' | 'MEMORY_DISTILLER_REQUIRED'
  | 'MEMORY_EVALUATOR_REQUIRED';
export class MemoryJournalError extends Error {
  constructor(readonly code: MemoryJournalErrorCode) { super(code); this.name = 'MemoryJournalError'; }
}
