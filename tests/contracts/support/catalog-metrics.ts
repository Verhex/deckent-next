import { deckentMetricsSchema, type DeckentMetrics } from '#domain/index.js';
import type { CatalogEvolutionRow } from '#engine/index.js';

/** S8-2 fixtures: metrics v2 rows as the producers seal them (schema-checked), at a known time, for the catalog evolution statistics. */
export const NOW = Date.UTC(2026, 9, 23, 12);
export const DAY = 86_400_000;
export type MetricSpec = { scope?: string; run?: string; task: string; attempt?: number; status?: 'accepted' | 'failed' | 'awaiting-decision'; kind?: 'task' | 'quota-park' | 'run';
  cause?: string; agent?: readonly [string, number] | null; workClass?: string | null; durationMs?: number | null; cost?: string | null; model?: readonly [string, string] | null;
  kinds?: readonly string[]; decision?: 'system' | 'human'; assigned?: boolean; effort?: string | null };
export function metric(spec: MetricSpec): DeckentMetrics {
  const workClass = spec.workClass === undefined ? 'feature' : spec.workClass, kind = spec.kind ?? 'task', status = spec.status ?? 'accepted';
  return deckentMetricsSchema.parse({ schemaVersion: 2,
    identity: { scopeId: spec.scope ?? 'scope', runId: spec.run ?? `run-${spec.task}`, taskId: spec.task, attemptId: `${spec.task}-a${spec.attempt ?? 1}` },
    workClass, policyRevision: workClass === null ? null : 'policy-1', profileVersion: null, skillSetDigest: spec.agent ? 'c'.repeat(64) : null,
    model: spec.model === null ? null : { channelId: spec.model?.[0] ?? 'channel-a', modelId: spec.model?.[1] ?? 'model-a' },
    durationMs: spec.durationMs === undefined ? 1000 : spec.durationMs, cost: spec.cost ? { basis: 'measured-tariff', amountUsdNanos: spec.cost, tariffDigest: 'd'.repeat(64) } : null,
    attemptSequence: spec.attempt ?? 1, evidenceReferences: [],
    effort: spec.effort ? { schemaVersion: 1, level: spec.effort, source: 'explicit', status: 'selected' } : null, actualModel: null,
    outcome: kind === 'task' ? { kind, status, decision: spec.decision ?? 'system' } : kind === 'run' ? { kind, status: 'incomplete' } : { kind, channelId: 'channel-a' },
    evidenceKinds: [...spec.kinds ?? (kind === 'task' ? ['exit-code'] : [])].sort(), acceptanceScore: null,
    ...spec.assigned ? { assignment: { candidatePolicy: { id: 'policy-1', version: 1 }, candidateIndex: 0, workClassRevision: 'wc-1', catalogRevision: 'cat-1',
      modelRevision: 1, activationRevision: 1, effortSource: 'candidate' } } : {},
    ...spec.agent ? { agent: { agentId: spec.agent[0], revision: spec.agent[1] } } : {},
    ...kind === 'task' && status === 'failed' && spec.cause ? { failureCause: spec.cause } : {} });
}
/** Rows in feed order (ascending position), each `daysAgo` before NOW (null: no sealed time). */
export function feed(...specs: readonly (MetricSpec & { daysAgo?: number | null })[]): CatalogEvolutionRow[] {
  return specs.map((spec, index) => ({ position: index + 1, digest: String(index + 1).padStart(64, '0'),
    atMs: spec.daysAgo === null ? null : NOW - (spec.daysAgo ?? 1) * DAY, metric: metric(spec) }));
}
