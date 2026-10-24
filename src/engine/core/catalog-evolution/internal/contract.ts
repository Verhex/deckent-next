import { z } from 'zod';
import { AGENT_CATALOG_LIMITS, catalogIdSchema, identitySchema, type DeckentMetrics, type VerifiedPrincipal } from '#domain/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AgentCatalogStore, CatalogSuggestion } from '#engine/core/agent-catalog/index.js';
import type { CatalogLessonSource } from './rules.js';

/** One current metrics row as the ledger holds it: its row position, the record digest it was sealed with and the sealed time of the producer
 * command that wrote it (`null` when the producer recorded none: such a row never enters an age-bounded window). */
export type CatalogEvolutionRow = Readonly<{ position: number; digest: string; atMs: number | null; metric: DeckentMetrics }>;
const wilson = z.object({ lowerMicro: z.number().int(), upperMicro: z.number().int() }).strict().nullable();
const keyRecord = z.object({ kind: z.enum(['agent', 'work-class']), agentId: z.string().optional(), revision: z.number().int().positive().optional(), workClass: z.string(),
  decided: z.number().int().nonnegative(), n: z.number().int().nonnegative(), successes: z.number().int().nonnegative(), wilson, inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/**
 * S8-2 aggregator pass record (rebuildable state, never authority): the durable position after which the next pass reads, and the statistics of the
 * keys this pass touched, each citing its window by the digest of its ordered (position, record digest) list. `shadow` and `on` write the same
 * record in S8-2 (no suggestion, card or narrowing exists before S8-3/S8-4); the mode is stated on it.
 */
/** The pass modes that write a record (`catalogEvolution.mode` off writes nothing). */
export const CATALOG_EVOLUTION_PASS_MODES = Object.freeze(['shadow', 'on'] as const);
const count = z.number().int().nonnegative();
export const catalogEvolutionPassSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, mode: z.enum(CATALOG_EVOLUTION_PASS_MODES),
  previousPosition: count, position: z.number().int().positive(), asOfMs: count,
  registry: z.object({ revision: z.string(), digest: z.string() }).strict(), rowsRead: count, truncated: z.boolean(),
  keys: z.array(keyRecord).readonly(), skippedKeys: count,
  /** S8-3: what this pass wrote (signed by the aggregator's key) and how many candidates the open-suggestion bound held back. */
  suggestions: z.object({ written: count, superseded: count, narrowed: count, skipped: count }).strict().optional() }).strict().readonly();
/** S8-3 incremental pass: one key's kept window rows (`keepWindow`), rebuildable cache, never authority; `registryDigest` null = invalid (rebuilt on next use). */
const entry = z.object({ position: z.number().int().positive(), digest: z.string(), atMs: z.number().int().nullable(), task: z.string(), sequence: z.number().int().positive(),
  workClass: z.string().nullable(), agent: z.object({ agentId: z.string(), revision: z.number().int().positive() }).strict().nullable(), status: z.enum(['accepted', 'failed', 'awaiting-decision']),
  cause: z.string().optional(), legacy: z.boolean(), durationMs: z.number().nullable(), cost: z.string().nullable(), model: z.object({ channelId: z.string(), modelId: z.string() }).strict().nullable(),
  effort: z.string().nullable(), human: z.boolean(), assigned: z.boolean(), kinds: z.array(z.string()) }).strict();
const event = z.object({ position: z.number().int().positive(), atMs: z.number().int().nullable(), workClass: z.string().nullable(),
  agent: z.object({ agentId: z.string(), revision: z.number().int().positive() }).strict().nullable(), kind: z.enum(['quota-park', 'run-incomplete']) }).strict();
export const catalogEvolutionWindowSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, keyDigest: z.string().regex(/^[a-f0-9]{64}$/), registryDigest: z.string().nullable(),
  position: count, tasks: z.array(entry), events: z.array(event) }).strict().readonly();
export type CatalogEvolutionWindow = z.infer<typeof catalogEvolutionWindowSchema>;
export type CatalogEvolutionPass = z.infer<typeof catalogEvolutionPassSchema>;
export type CatalogEvolutionKeyRecord = CatalogEvolutionPass['keys'][number];
/** DB-neutral store of the pass (Core SQLite; Enterprise may store it elsewhere). Rows are scope-filtered and digest-checked by the adapter. */
export interface CatalogEvolutionStore {
  /** The scope's current task, quota-park and run rows, newest first, at most `limit`; with `upTo`, only rows at or before that position. */
  recentRows(scopeId: string, limit: number, upTo?: number): Promise<readonly CatalogEvolutionRow[]>;
  /** The scope's current rows after `after` (a row position), oldest first, at most `limit`. */
  rowsAfter(scopeId: string, after: number, limit: number): Promise<readonly CatalogEvolutionRow[]>;
  lastPass(scopeId: string): Promise<CatalogEvolutionPass | null>;
  /** Compare-and-set on the previous position (`expected`, 0 = none yet): a concurrent pass of the same scope is refused, never doubled. S8-3: the touched
   * keys' windows are written in the same transaction. */
  recordPass(record: CatalogEvolutionPass, expected: number, windows?: readonly CatalogEvolutionWindow[]): Promise<void>;
  /** S8-3: the cached windows of these keys (absent: none yet). */
  windows(scopeId: string, keyDigests: readonly string[]): Promise<ReadonlyMap<string, CatalogEvolutionWindow>>;
  close(): void;
}
export type ModelFacts = (channelId: string, modelId: string) => Readonly<{ maker: string | null; tier: string | null }>;
export interface CatalogEvolutionDependencies {
  readonly verifier: PrincipalVerifier;
  /** The agent catalog's own `agent-catalog`/`inspect` decision: statistics are a catalog read (MCP joins the S7 read family). */
  readonly authorize: (action: 'inspect', scopeId: string, principal: VerifiedPrincipal) => Promise<unknown>;
  readonly openCatalog: () => Promise<Pick<AgentCatalogStore, 'loadAgent' | 'listAgents' | 'standings' | 'eligibleAgents' | 'suggestions' | 'listSkills' | 'close'>>;
  /** S8-3: the aggregator's signed writer (the catalog's standing application under `<owner>/catalog-aggregator`); absent or without an active key, the pass
   * writes nothing at all (S8-DESIGN §8: read-only), so the rows wait for the key and none is skipped. `producer` names the aggregator on every record. */
  readonly writer?: Readonly<{ producer: Readonly<{ issuer: string; subject: string }>; ready(scopeId: string): Promise<boolean>;
    record(scopeId: string, change: { readonly suggestions: readonly CatalogSuggestion[]; readonly narrow: readonly string[] }): Promise<{ readonly written: number; readonly superseded: number; readonly narrowed: number }> }>;
  /** S8-3 S1: the scope's verified lesson refs (no text) the aggregator may count, read under its own `memory`/`inspect`. */
  readonly lessons?: (scopeId: string) => Promise<readonly CatalogLessonSource[]>;
  readonly openStore: (access: 'read' | 'write') => Promise<CatalogEvolutionStore>;
  /** The installation overlay of the `catalog-evolution` registry (protected config `catalogEvolution.overlay`); absent: the Core seed alone. */
  readonly overlay?: unknown;
  /** Canonical maker and tier of an exact model, from the catalog and the tier registry at read time (display only; null = unknown). */
  readonly modelFacts?: (scopeId: string) => Promise<ModelFacts>;
  readonly mode: 'off' | 'shadow' | 'on';
  readonly now: () => number;
}
export const agentStatsQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, agentId: catalogIdSchema.optional(),
  limit: z.number().int().positive().max(AGENT_CATALOG_LIMITS.pageMax).optional() }).strict();
export type AgentStatsQuery = z.infer<typeof agentStatsQuerySchema>;
/** Statistics of one key over its window (S8-DESIGN §4). `n` = accepted + attributable failures only; every other outcome is counted apart. */
export type KeyStats = Readonly<{
  decided: number; n: number; successes: number; wilson: Readonly<{ lowerMicro: number; upperMicro: number }> | null;
  failures: Readonly<Record<string, number>>; unattributable: Readonly<Record<string, number>>; nonAttributableShareMicro: number | null;
  excluded: Readonly<{ awaitingDecision: number; quotaPark: number; runIncomplete: number; unknownEvidence: number; legacy: number; undated: number }>;
  effort: Readonly<{ p50Ms: number | null; p90Ms: number | null; costUsdNanos: string | null; costRows: number; effortMix: Readonly<Record<string, number>>;
    pinned: number; assigned: number; humanDecisions: number; evidenceKinds: Readonly<Record<string, number>> }>;
  periods: number; models: number;
  perModel: readonly Readonly<{ channelId: string | null; modelId: string | null; maker: string; tier: string; n: number; successes: number }>[] | null; otherModels: number;
  window: Readonly<{ tasks: number; firstPosition: number | null; lastPosition: number | null; inputDigest: string }>;
}>;
export type AgentStatsKey = Readonly<{ revision: number; workClass: string; standing: string | null; stats: KeyStats; baseline: KeyStats;
  active: Readonly<{ agentId: string; revision: number; stats: KeyStats }> | null; effortRatioMicro: number | null;
  skills: readonly Readonly<{ skillId: string; revision: number; digest: string; stats: KeyStats }>[] | null }>;
export type RollupStats = Readonly<{ workClass: string; members: number; decided: number; n: number; successes: number;
  wilson: Readonly<{ lowerMicro: number; upperMicro: number }> | null; failures: Readonly<Record<string, number>>; unattributable: Readonly<Record<string, number>> }>;
/** `deckent agents stats` / MCP `inspect_agent_stats` (one typed contract). Every number is an association, never a cause, and an acceptance
 * rate, never accuracy: both labels travel on the view itself so JSON readers carry them too. */
export type AgentStatsView = Readonly<{ schemaVersion: 1; scopeId: string; labels: Readonly<{ relation: 'association-not-causation'; rate: 'acceptance-rate-not-accuracy' }>;
  mode: 'off' | 'shadow' | 'on'; registry: Readonly<{ revision: string; status: string; digest: string }>; asOfMs: number; rows: Readonly<{ read: number; truncated: boolean }>;
  lastPass: CatalogEvolutionPass | null; status: 'ok' | 'not-found';
  agents: readonly Readonly<{ agentId: string; name: string; revision: number; parentAgentId: string | null; keys: readonly AgentStatsKey[]; rollup: readonly RollupStats[] }>[];
  workClasses: readonly Readonly<{ workClass: string; stats: KeyStats }>[] }>;
