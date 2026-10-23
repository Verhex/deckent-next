import { z } from 'zod';
import { AGENT_CATALOG_LIMITS, catalogIdSchema, catalogSignatureSchema, clientCommandIdSchema, counterSchema, encodeCommandProjection, identitySchema, type AgentStanding, type AuditEvent,
  type CatalogAction } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

/**
 * S8-3 `catalog-suggestion v1` (S8-DESIGN §6, §11): one sealed "consider this" record of the catalog aggregator. It changes nothing by itself; a person's
 * card (or a signed, granted AI command) decides it. Refs, digests and counts only: a lesson draft is never stored — only the lesson refs it is rendered
 * from at card time, under the deciding person's read filter (fold A). The id is the digest of the whole content, so a replayed pass writes the same id
 * and bytes (N10) and any changed input is a new id. Statistics are associations and acceptance rates; their labels travel on every view.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/), positive = counterSchema.positive();
export const CATALOG_SUGGESTION_KINDS = ['promote-agent', 'redesign-agent', 'revise-agent', 'propose-agent', 'propose-skill'] as const;
export const CATALOG_SUGGESTION_STATES = ['open', 'decided', 'dismissed', 'superseded'] as const;
/** The aggregator modes that write a suggestion (`catalogEvolution.mode` off writes nothing); `shadow` rows are records only, never a card. */
export const CATALOG_SUGGESTION_MODES = Object.freeze(['shadow', 'on'] as const);
export const catalogSuggestionKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: catalogIdSchema, revision: positive, workClass: identitySchema }).strict(),
  z.object({ kind: z.literal('work-class'), workClass: identitySchema }).strict(),
  /** A lesson audience (S4B §4.3): the WorkClass family and work target; `null` family = a person's scope-wide entries. */
  z.object({ kind: z.literal('audience'), workClassFamily: identitySchema.nullable(), workTargetId: identitySchema.nullable() }).strict()]);
export const catalogLessonRefSchema = z.object({ entryId: identitySchema, revision: positive, contentDigest: digest }).strict();
const stats = z.record(z.string(), z.unknown());
export const catalogSuggestionSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, suggestionId: digest, kind: z.enum(CATALOG_SUGGESTION_KINDS),
  mode: z.enum(CATALOG_SUGGESTION_MODES), key: catalogSuggestionKeySchema, keyDigest: digest, rule: z.object({ id: identitySchema, version: positive, status: z.enum(['provisional', 'calibrated']) }).strict(),
  registry: z.object({ revision: z.string(), digest }).strict(),
  window: z.object({ after: counterSchema, firstPosition: counterSchema.nullable(), lastPosition: counterSchema.nullable(), tasks: counterSchema, n: counterSchema, inputDigest: digest }).strict(),
  stats: stats.nullable(), baseline: stats.nullable(), active: z.object({ agentId: catalogIdSchema, revision: positive, stats }).strict().nullable(), effortRatioMicro: counterSchema.nullable(),
  proposed: z.discriminatedUnion('kind', [z.object({ kind: z.literal('standing'), to: z.enum(['active', 'redesign-required']) }).strict(), z.object({ kind: z.literal('revise') }).strict(),
    z.object({ kind: z.literal('agent-draft'), template: identitySchema }).strict(),
    z.object({ kind: z.literal('skill-draft'), template: identitySchema, lessons: z.array(catalogLessonRefSchema).min(1).max(AGENT_CATALOG_LIMITS.pageMax), lessonSetDigest: digest }).strict()]),
  producer: z.object({ issuer: identitySchema, subject: identitySchema }).strict(), asOfMs: counterSchema, expiresAtMs: counterSchema }).strict().readonly();
export type CatalogSuggestion = z.infer<typeof catalogSuggestionSchema>;
export type CatalogSuggestionKey = z.infer<typeof catalogSuggestionKeySchema>;
export type CatalogLessonRef = z.infer<typeof catalogLessonRefSchema>;
const actor = z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict();
/** One state of a suggestion (kept history; `open` → decided | dismissed | superseded once; expiry is read-time: open past `expiresAtMs`). */
export const catalogSuggestionStateSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, suggestionId: digest, state: z.enum(CATALOG_SUGGESTION_STATES),
  revision: positive, by: actor, atMs: counterSchema, commandId: identitySchema.nullable(), decision: identitySchema.nullable(), supersededBy: digest.nullable(),
  signed: z.object({ keyId: digest, signatureDigest: digest }).strict().optional() }).strict().readonly();
export type CatalogSuggestionState = z.infer<typeof catalogSuggestionStateSchema>;
export type StoredCatalogSuggestion = Readonly<{ record: CatalogSuggestion; state: CatalogSuggestionState }>;
/** The id of a suggestion and of its key: canonical projections, so the same inputs always give the same ids. */
export const catalogSuggestionKeyDigest = (key: CatalogSuggestionKey) => sha256(encodeCommandProjection('catalog-suggestion-key:1', key));
export const catalogSuggestionIdOf = (content: Omit<CatalogSuggestion, 'suggestionId'>) => sha256(encodeCommandProjection('catalog-suggestion:1', content));
/** What the scope's grants name for a suggestion or standing action: the WorkClass (`<scopeId>/<workClass>`; a lesson audience: its family, else the scope). */
export const catalogSuggestionWorkClass = (key: CatalogSuggestionKey) => key.kind === 'audience' ? key.workClassFamily : key.workClass;

const scoped = { schemaVersion: z.literal(1), scopeId: identitySchema };
const signed = catalogSignatureSchema.optional();
const target = { agentId: catalogIdSchema, revision: positive, workClass: identitySchema, expectedStandingRevision: positive };
/** S8-4 standing card (a person's terminal act) or a signed, WorkClass-granted AI command; `suggestionId` names the suggestion it decides (null: none). */
export const standingChangeCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, action: z.enum(['promote', 'demote', 'restore', 'retire']), ...target,
  suggestionId: digest.nullable(), signed }).strict();
export const suggestionDismissCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema, suggestionId: digest, expectedStateRevision: positive, signed }).strict();
/** A person's bulk card: `reset` (every promoted or narrowed current revision of one WorkClass back to candidate) or, on a revoke card, the one-step
 * demote of every promotion the revoked key signed. `targets` are exactly the rows the card showed (compare-and-set on each). */
export const standingBulkCommandSchema = z.object({ ...scoped, commandId: clientCommandIdSchema,
  reason: z.discriminatedUnion('kind', [z.object({ kind: z.literal('reset'), workClass: identitySchema }).strict(), z.object({ kind: z.literal('signer-revoked'), keyId: digest }).strict()]),
  targets: z.array(z.object(target).strict()).min(1).max(AGENT_CATALOG_LIMITS.agentsPerScopeMax) }).strict();
export const suggestionListQuerySchema = z.object({ ...scoped, open: z.boolean().optional(), limit: z.number().int().min(1).max(AGENT_CATALOG_LIMITS.pageMax) }).strict();
export const suggestionInspectQuerySchema = z.object({ ...scoped, suggestionId: digest }).strict();
/** The promotions a revoked key signed that are still in effect (`keyId`: only that key's). */
export const revokedPromotionsQuerySchema = z.object({ ...scoped, keyId: digest.optional() }).strict();
export type StandingChangeCommand = z.infer<typeof standingChangeCommandSchema>;
export type SuggestionDismissCommand = z.infer<typeof suggestionDismissCommandSchema>;
export type StandingBulkCommand = z.infer<typeof standingBulkCommandSchema>;
export type SuggestionListQuery = z.infer<typeof suggestionListQuerySchema>;
export type SuggestionInspectQuery = z.infer<typeof suggestionInspectQuerySchema>;

/** A suggestion as a reader sees it: the effective state (open past its expiry reads `expired`), lesson refs only the reader may read (the rest a
 * count, never their ids, N23) and whether its producer's key was revoked since. Never draft or lesson text. */
export type CatalogSuggestionView = Readonly<Omit<CatalogSuggestion, 'proposed'> & { proposed: CatalogSuggestion['proposed'] | Readonly<{ kind: 'skill-draft'; template: string;
  lessons: readonly CatalogLessonRef[]; withheld: number; lessonSetDigest: string }>; state: CatalogSuggestionState['state'] | 'expired'; stateRevision: number; decidedBy: CatalogSuggestionState['by'] | null;
  decision: string | null; signerRevoked: boolean }>;
export type CatalogSuggestionListing = Readonly<{ schemaVersion: 1; scopeId: string; labels: Readonly<{ relation: 'association-not-causation'; rate: 'acceptance-rate-not-accuracy' }>;
  items: readonly CatalogSuggestionView[] }>;
export type CatalogSuggestionInspection = Readonly<{ schemaVersion: 1; status: 'ok'; labels: CatalogSuggestionListing['labels']; item: CatalogSuggestionView;
  standing: AgentStanding | null; history: readonly CatalogSuggestionState[] }> | Readonly<{ schemaVersion: 1; status: 'not-found'; suggestionId: string }>;

/** One atomic change of standings and suggestions (S8-3/S8-4): a card command (`receipt`), or an aggregator write (no receipt: each suggestion is its own
 * idempotency key). The store verifies every AI/system signature against `catalogEvolutionActions` of the change inside its write transaction. */
export interface CatalogEvolutionChange {
  readonly scopeId: string; readonly principal: Readonly<{ issuer: string; subject: string; ai: boolean }>;
  readonly receipt: Readonly<{ scopeId: string; commandId: string; digest: string }> | null;
  readonly standings: readonly Readonly<{ previous: AgentStanding; next: AgentStanding; action: 'promote' | 'demote' | 'restore' | 'retire' | 'narrow' }>[];
  readonly suggestions: readonly CatalogSuggestion[];
  /** `previous` null: a new suggestion's opening `open` state (revision 1). */
  readonly states: readonly Readonly<{ previous: CatalogSuggestionState | null; next: CatalogSuggestionState }>[];
  readonly signed: readonly Readonly<{ action: CatalogAction; keyId: string; signature: string }>[];
  readonly events: readonly AuditEvent[];
}
const agentTarget = (row: AgentStanding) => ({ kind: 'agent' as const, id: row.agentId, revision: row.revision, workClass: row.workClass });
const keyTarget = (record: CatalogSuggestion, scopeId: string) => record.key.kind === 'agent' ? { kind: 'agent' as const, id: record.key.agentId, revision: record.key.revision, workClass: record.key.workClass }
  : { kind: 'work-class' as const, id: catalogSuggestionWorkClass(record.key) ?? scopeId, revision: 1 };
/**
 * The exact `catalog-action:1` commands an AI/system change must carry, derived from the rows it commits (the application signs these; the store
 * re-derives and compares them before it verifies a signature): a card's first standing change (a promotion's displaced agent rides on it) or its
 * dismissal; an aggregator write's every new suggestion (`suggest`; superseding the older one rides on it) and every rule narrowing (`narrow`).
 */
export function catalogEvolutionActions(change: Omit<CatalogEvolutionChange, 'signed' | 'events'>, records: ReadonlyMap<string, CatalogSuggestion>): CatalogAction[] {
  const principal = { issuer: change.principal.issuer, subject: change.principal.subject }, scopeId = change.scopeId;
  if (change.receipt) {
    const first = change.standings[0], dismissed = change.states.find(row => row.next.state === 'dismissed');
    const base = { scopeId, commandId: change.receipt.commandId, contentDigest: change.receipt.digest, principal };
    if (first) return [{ ...base, action: first.action, target: agentTarget(first.next), expectedRevision: first.previous.standingRevision, toStanding: first.next.standing,
      suggestionId: first.next.basis.suggestionId }];
    const record = dismissed?.previous && records.get(dismissed.next.suggestionId);
    return record ? [{ ...base, action: 'dismiss', target: keyTarget(record, scopeId), expectedRevision: dismissed.previous!.revision, toStanding: null, suggestionId: record.suggestionId }] : [];
  }
  return [...change.suggestions.map(record => ({ scopeId, action: 'suggest' as const, target: keyTarget(record, scopeId), expectedRevision: null, contentDigest: record.suggestionId,
    toStanding: null, suggestionId: record.suggestionId, commandId: `catalog-suggest:${record.suggestionId}`, principal })),
  ...change.standings.map(row => ({ scopeId, action: 'narrow' as const, target: agentTarget(row.next), expectedRevision: row.previous.standingRevision, contentDigest: row.next.basis.suggestionId!,
    toStanding: row.next.standing, suggestionId: row.next.basis.suggestionId, commandId: `catalog-narrow:${row.next.basis.suggestionId}`, principal }))];
}
/** The audit subject of one suggestion step (refs, digests, counts; N28). */
export const catalogSuggestionAuditSubject = (record: CatalogSuggestion, action: 'suggest' | 'supersede' | 'decide' | 'dismiss', state: CatalogSuggestionState) => ({ kind: 'catalog-suggestion' as const,
  action, suggestionId: record.suggestionId, suggestionKind: record.kind, keyDigest: record.keyDigest, inputDigest: record.window.inputDigest, ruleId: record.rule.id, ruleVersion: record.rule.version,
  state: state.state, ...(state.signed ? { signed: state.signed } : {}) });
