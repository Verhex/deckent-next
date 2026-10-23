import { canonicalModelMaker, composeMemoryAutomation, modelInvocationProfileSchema, type ModelReference } from '#domain/index.js';
import { inspectRoleModelsInScope, roleModelPorts, type ModelCatalogReader, type RoleModelSources } from '#engine/core/model-activation/index.js';
import type { MemoryEvaluatorRow } from './contract.js';

/** The S2 role a memory evaluator model must hold (registry data; the role registry restricts V5 to its rows). */
export const MEMORY_EVALUATOR_ROLE = 'memory-evaluator';
const BILLING: Readonly<Record<string, MemoryEvaluatorRow['billing']>> = Object.freeze({ subscription: 'subscription', 'per-token': 'metered', 'self-hosted': 'local' });
export type MemoryCatalogFact = { readonly maker: string | null; readonly billing: MemoryEvaluatorRow['billing']; readonly pricing: unknown };
export const memoryCatalogKey = (channelId: string, modelId: string) => JSON.stringify([channelId, modelId]);
/** S4B-3 §6.7: every registered catalog model with its canonical maker (alias registry; provider-chosen = unknown), its channel's billing and its
 * catalog price, read once per pass. No model or vendor name is a literal here: everything is catalog data. */
export async function memoryCatalogFacts(catalog: ModelCatalogReader): Promise<ReadonlyMap<string, MemoryCatalogFact>> {
  const facts = new Map<string, MemoryCatalogFact>();
  for (const channel of await catalog.channels()) {
    const billing = (channel.channel as { billing?: string }).billing;
    for (const row of await catalog.models(channel.channelId)) facts.set(memoryCatalogKey(row.channelId, row.modelId), { maker: canonicalModelMaker(row.model),
      billing: billing === undefined ? null : BILLING[billing] ?? null, pricing: (row.model as { pricing?: unknown }).pricing ?? null });
  }
  return facts;
}
/** The declared reference that has an invocation profile in the scope for this (channel, exact model): the only invocable path (none: null). */
export function memoryEvaluatorReference(sources: RoleModelSources, profiles: unknown, scopeId: string, target: { readonly channelId: string; readonly modelId: string }): ModelReference | null {
  const held = ((profiles as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  const references = sources.providerCatalog === undefined ? [] : roleModelPorts(sources).references(target);
  return references.find(reference => held.some(profile => profile.scopeId === scopeId && JSON.stringify(profile.reference) === JSON.stringify(reference))) ?? null;
}
/** The scope's evaluator rows today: active `memory-evaluator` role rows (S2), each with its catalog maker and billing and whether it is invocable. */
export async function memoryEvaluatorRows(sources: RoleModelSources, profiles: unknown, scopeId: string, facts: ReadonlyMap<string, MemoryCatalogFact>, nowMs: number): Promise<readonly MemoryEvaluatorRow[]> {
  const listed = await inspectRoleModelsInScope(sources, MEMORY_EVALUATOR_ROLE, scopeId, nowMs);
  return listed.models.filter(row => row.active).map(row => { const fact = facts.get(memoryCatalogKey(row.channelId, row.modelId));
    return { channelId: row.channelId, modelId: row.modelId, maker: fact?.maker ?? null, billing: fact?.billing ?? null, invocable: memoryEvaluatorReference(sources, profiles, scopeId, row) !== null }; });
}
/** Whether a scope's evaluator pass is due: at most one per `evaluation.passIntervalMs` (the reconciliation loop polls far more often). */
export const memoryEvaluationDue = (overlay: unknown, lastMs: number | undefined, nowMs: number) =>
  lastMs === undefined || nowMs - lastMs >= composeMemoryAutomation(overlay).evaluation.passIntervalMs;
/** `value × factor ÷ 10^6` as an exact decimal string (catalog prices are decimals per million tokens; no float, no rounding). */
function perMillion(value: string, factor: number): string {
  const [whole, fraction = ''] = value.split('.'), scaled = BigInt(whole! + fraction) * BigInt(factor), digits = fraction.length + 6, text = scaled.toString().padStart(digits + 1, '0');
  const out = `${text.slice(0, -digits)}.${text.slice(-digits)}`.replace(/\.?0+$/u, '');
  return out === '' ? '0' : out;
}
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/u;
export type MemoryEvaluatorPrice = { readonly kind: 'per-token'; readonly inputPerMTok: string; readonly outputPerMTok: string; readonly asOf: string; readonly answersPerDayCeiling: string }
  | { readonly kind: 'subscription' } | { readonly kind: 'not-verified' };
/**
 * S4B-3 read-only view (owner S-M5: cost computed from catalog data, never a number in code): which evaluator rows would serve the scope, each
 * with its maker, whether it can be called here, and its price — the catalog per-token price with the most the answers can cost in a day at the
 * registry caps (calls per day × answer token cap × output price), a subscription channel (quota only), or "not verified". An entry is still
 * evaluated only by a row of another maker than its source worker's.
 */
export function memoryEvaluatorView(rows: readonly MemoryEvaluatorRow[], facts: ReadonlyMap<string, MemoryCatalogFact>, overlay: unknown) {
  const { evaluation } = composeMemoryAutomation(overlay), cap = evaluation.perScopePerDay * evaluation.maxCompletionTokens;
  const priced = (row: MemoryEvaluatorRow): MemoryEvaluatorPrice => {
    if (row.billing === 'subscription') return { kind: 'subscription' };
    const pricing = facts.get(memoryCatalogKey(row.channelId, row.modelId))?.pricing as { kind?: string; asOf?: string; inputPerMTok?: string; outputPerMTok?: string } | null | undefined;
    return pricing?.kind === 'per-token' && DECIMAL.test(pricing.inputPerMTok ?? '') && DECIMAL.test(pricing.outputPerMTok ?? '') && typeof pricing.asOf === 'string'
      ? { kind: 'per-token', inputPerMTok: pricing.inputPerMTok!, outputPerMTok: pricing.outputPerMTok!, asOf: pricing.asOf, answersPerDayCeiling: perMillion(pricing.outputPerMTok!, cap) }
      : { kind: 'not-verified' };
  };
  const listed = rows.map(row => ({ ...row, price: priced(row) }));
  return Object.freeze({ schemaVersion: 1 as const, callsPerDay: evaluation.perScopePerDay, maxCompletionTokens: evaluation.maxCompletionTokens, rows: listed,
    available: listed.some(row => row.invocable && row.maker !== null) });
}
