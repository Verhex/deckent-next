import { ATTRIBUTABLE_FAILURE_CAUSES, CatalogEvolutionError, NON_ATTRIBUTABLE_FAILURE_CAUSES, STATS_MICRO, attributableFailure, nearestRankMicro, wilsonIntervalMicro,
  type CatalogEvolutionRegistry } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { CatalogEvolutionRow, KeyStats, ModelFacts, RollupStats } from './contract.js';

const DAY_MS = 86_400_000;
/** One counted Task (its current task row of the highest Attempt) or one excluded observation (quota park, Run incomplete). */
export type CatalogEntry = Readonly<{ position: number; digest: string; atMs: number | null; task: string; sequence: number; workClass: string | null; agent: Readonly<{ agentId: string; revision: number }> | null;
  status: 'accepted' | 'failed' | 'awaiting-decision'; cause: string | undefined; legacy: boolean; durationMs: number | null; cost: string | null;
  model: Readonly<{ channelId: string; modelId: string }> | null; effort: string | null; human: boolean; assigned: boolean; kinds: readonly string[] }>;
export type CatalogEvent = Readonly<{ position: number; atMs: number | null; workClass: string | null; agent: CatalogEntry['agent']; kind: 'quota-park' | 'run-incomplete' }>;
export type CatalogEntries = Readonly<{ tasks: readonly CatalogEntry[]; events: readonly CatalogEvent[] }>;
type Match = (row: Pick<CatalogEntry, 'workClass' | 'agent'>) => boolean;

/**
 * Per Task, not per Attempt (S8-DESIGN §4): the current row of the highest `attemptSequence` (a lost or stalled earlier Attempt wrote no task row,
 * a human decision already superseded the system row in the ledger). Quota parks and Run-incomplete rows are observations, never outcomes. A row
 * of another scope is a corrupt feed (N9), never pooled.
 */
export function catalogEntries(scopeId: string, rows: readonly CatalogEvolutionRow[]): CatalogEntries {
  const tasks: CatalogEntry[] = [], events: CatalogEvent[] = [];
  for (const { position, digest, atMs, metric } of rows) {
    if (metric.identity.scopeId !== scopeId) throw new CatalogEvolutionError('CATALOG_EVOLUTION_CORRUPT');
    const v2 = metric.schemaVersion === 2 ? metric : null, agent = v2?.agent ?? null;
    if (metric.outcome.kind !== 'task') { events.push({ position, atMs, workClass: metric.workClass, agent, kind: metric.outcome.kind === 'quota-park' ? 'quota-park' : 'run-incomplete' }); continue; }
    tasks.push({ position, digest, atMs, task: JSON.stringify([metric.identity.runId, metric.identity.taskId]), sequence: metric.attemptSequence, workClass: metric.workClass, agent,
      status: metric.outcome.status, cause: v2?.failureCause, legacy: !v2, durationMs: metric.durationMs, cost: metric.cost?.amountUsdNanos ?? null, model: metric.model,
      effort: v2?.effort?.level ?? null, human: v2?.outcome.kind === 'task' && v2.outcome.decision === 'human', assigned: v2?.assignment !== undefined, kinds: v2?.evidenceKinds ?? [] });
  }
  return mergeEntries({ tasks: [], events: [] }, { tasks, events });
}
/** One Task once: its row of the highest Attempt, and for one Attempt the later current row (a human decision after the system row). Ordered by position. */
export function mergeEntries(held: CatalogEntries, fresh: CatalogEntries): CatalogEntries {
  const tasks = new Map<string, CatalogEntry>();
  for (const row of [...held.tasks, ...fresh.tasks]) {
    const prior = tasks.get(row.task);
    if (!prior || prior.sequence < row.sequence || (prior.sequence === row.sequence && prior.position < row.position)) tasks.set(row.task, row);
  }
  const events = new Map([...held.events, ...fresh.events].map(row => [row.position, row] as const));
  return { tasks: [...tasks.values()].sort((a, b) => a.position - b.position), events: [...events.values()].sort((a, b) => a.position - b.position) };
}
/**
 * S8-3 incremental pass: what a key's cached window keeps — the last `windowTasks` dated, decided, counted-kind Tasks, the last `windowTasks` of every
 * other Task (awaiting, legacy, undated, unknown-only evidence) and of the quota-park and Run-incomplete observations. Statistics over the kept rows
 * equal those over the full feed for the window rule; the counts set apart are bounded the same way (display only).
 */
export function keepWindow(entries: CatalogEntries, registry: CatalogEvolutionRegistry): CatalogEntries {
  const { windowTasks } = registry.stats, last = <T>(rows: readonly T[]) => rows.slice(Math.max(rows.length - windowTasks, 0));
  const eligible = (row: CatalogEntry) => !row.legacy && row.status !== 'awaiting-decision' && row.atMs !== null && !unknownOnly(registry, row);
  return { tasks: [...last(entries.tasks.filter(eligible)), ...last(entries.tasks.filter(row => !eligible(row)))].sort((a, b) => a.position - b.position), events: last(entries.events) };
}
const unknownOnly = (registry: CatalogEvolutionRegistry, row: CatalogEntry) => registry.stats.excludeUnknownEvidence && row.kinds.length > 0 && row.kinds.every(kind => kind === 'unknown');
const tally = (values: readonly string[]) => Object.freeze(values.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] ?? 0) + 1; return out; }, {}));
const zeroes = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<string, number>;

/**
 * The statistics of every entry `match` selects (S8-DESIGN §4): the last `windowTasks` decided Tasks no older than `windowMaxDays` before `nowMs`
 * (`nowMs` is sealed on the pass record, so the window is reproducible), Wilson on accepted vs attributable failures, every other failure in its
 * own bucket, `unknown`-only evidence, legacy, undated, awaiting, quota-park and Run-incomplete rows counted apart. `facts` absent: no per-model split.
 */
export function keyStats(entries: CatalogEntries, registry: CatalogEvolutionRegistry, nowMs: number, match: Match, facts?: ModelFacts, after = 0): KeyStats {
  const { windowMaxDays, periodDays, modelMixMax, zMicro, durationPercentileMicro } = registry.stats, cutoff = nowMs - windowMaxDays * DAY_MS;
  const unknown = (row: CatalogEntry) => unknownOnly(registry, row);
  const matching = entries.tasks.filter(row => row.position > after && match(row)), recent = (row: { atMs: number | null }) => row.atMs !== null && row.atMs >= cutoff;
  const decided = matching.filter(row => !row.legacy && row.status !== 'awaiting-decision' && row.atMs !== null);
  const window = windowRows(entries, registry, nowMs, match, after);
  const counted = window.filter(row => row.status === 'accepted' || attributableFailure(row.cause)), successes = counted.filter(row => row.status === 'accepted');
  const failures = { ...zeroes(ATTRIBUTABLE_FAILURE_CAUSES), ...tally(counted.filter(row => row.status === 'failed').map(row => row.cause!)) };
  const others = window.filter(row => row.status === 'failed' && !attributableFailure(row.cause)), unattributable = { ...zeroes(NON_ATTRIBUTABLE_FAILURE_CAUSES), ...tally(others.map(row => row.cause ?? 'unattributed')) };
  const events = entries.events.filter(row => row.position > after && match(row) && recent(row)), durations = window.flatMap(row => row.durationMs === null ? [] : [row.durationMs]);
  const costs = window.filter(row => row.cost !== null), modelKey = (row: CatalogEntry) => JSON.stringify(row.model ? [row.model.channelId, row.model.modelId] : null);
  const groups = [...counted.reduce((out, row) => out.set(modelKey(row), [...out.get(modelKey(row)) ?? [], row]), new Map<string, CatalogEntry[]>())]
    .sort(([a, left], [b, right]) => right.length - left.length || (a < b ? -1 : a > b ? 1 : 0));
  const ascending = [...window].sort((a, b) => a.position - b.position);
  return Object.freeze({ decided: window.length, n: counted.length, successes: successes.length, wilson: wilsonIntervalMicro(successes.length, counted.length, zMicro),
    failures: Object.freeze(failures), unattributable: Object.freeze(unattributable),
    nonAttributableShareMicro: window.length ? Math.floor((others.length * STATS_MICRO) / window.length) : null,
    excluded: Object.freeze({ awaitingDecision: matching.filter(row => row.status === 'awaiting-decision' && !row.legacy && (row.atMs === null || recent(row))).length,
      quotaPark: events.filter(row => row.kind === 'quota-park').length, runIncomplete: events.filter(row => row.kind === 'run-incomplete').length,
      unknownEvidence: decided.filter(row => recent(row) && unknown(row)).length, legacy: matching.filter(row => row.legacy).length,
      undated: matching.filter(row => !row.legacy && row.status !== 'awaiting-decision' && row.atMs === null).length }),
    effort: Object.freeze({ p50Ms: nearestRankMicro(durations, STATS_MICRO / 2), p90Ms: nearestRankMicro(durations, durationPercentileMicro),
      costUsdNanos: costs.length ? costs.reduce((sum, row) => sum + BigInt(row.cost!), 0n).toString() : null, costRows: costs.length,
      effortMix: tally(window.flatMap(row => row.effort === null ? [] : [row.effort])), pinned: window.filter(row => row.model !== null && !row.assigned).length,
      assigned: window.filter(row => row.assigned).length, humanDecisions: window.filter(row => row.human).length, evidenceKinds: tally(window.flatMap(row => row.kinds)) }),
    periods: new Set(counted.map(row => Math.floor(row.atMs! / (periodDays * DAY_MS)))).size, models: new Set(counted.filter(row => row.model).map(modelKey)).size,
    perModel: facts ? Object.freeze(groups.slice(0, modelMixMax).map(([, rows]) => { const model = rows[0]!.model, fact = model ? facts(model.channelId, model.modelId) : null;
      return Object.freeze({ channelId: model?.channelId ?? null, modelId: model?.modelId ?? null, maker: fact?.maker ?? 'unknown', tier: fact?.tier ?? 'unknown',
        n: rows.length, successes: rows.filter(row => row.status === 'accepted').length }); })) : null,
    otherModels: Math.max(groups.length - modelMixMax, 0),
    window: Object.freeze({ tasks: window.length, firstPosition: ascending[0]?.position ?? null, lastPosition: ascending.at(-1)?.position ?? null,
      inputDigest: sha256(JSON.stringify(ascending.map(row => [row.position, row.digest]))) }) });
}
/** The window of a key (§4): its last `windowTasks` decided, dated Tasks no older than `windowMaxDays`, `unknown`-only evidence left out, newest first.
 * S8-3 `after`: windows of one (key, kind) never overlap — only rows after the previous decided, dismissed or restored window count. */
export function windowRows(entries: CatalogEntries, registry: CatalogEvolutionRegistry, nowMs: number, match: Match, after = 0): CatalogEntry[] {
  const cutoff = nowMs - registry.stats.windowMaxDays * DAY_MS;
  return entries.tasks.filter(row => row.position > after && match(row) && !row.legacy && row.status !== 'awaiting-decision' && row.atMs !== null && row.atMs >= cutoff && !unknownOnly(registry, row))
    .sort((a, b) => b.position - a.position).slice(0, registry.stats.windowTasks);
}
/** Key p50 duration ÷ the baseline's p50 over the same window rule, in micro-units; null when either has no duration. */
export const effortRatioMicro = (key: KeyStats, baseline: KeyStats) => key.effort.p50Ms === null || !baseline.effort.p50Ms ? null
  : Math.floor((key.effort.p50Ms * STATS_MICRO) / baseline.effort.p50Ms);
/** Org-tree roll-up (§4): a read-time sum of the members' counts for one WorkClass, with Wilson on the sum; display only, never a rule input. */
export function rollupStats(workClass: string, members: readonly KeyStats[], registry: CatalogEvolutionRegistry): RollupStats {
  const sum = (pick: (row: KeyStats) => number) => members.reduce((total, row) => total + pick(row), 0);
  const add = (pick: (row: KeyStats) => Readonly<Record<string, number>>) => Object.freeze(members.reduce<Record<string, number>>((out, row) => {
    for (const [key, value] of Object.entries(pick(row))) out[key] = (out[key] ?? 0) + value; return out; }, {}));
  const n = sum(row => row.n), successes = sum(row => row.successes);
  return Object.freeze({ workClass, members: members.length, decided: sum(row => row.decided), n, successes, wilson: wilsonIntervalMicro(successes, n, registry.stats.zMicro),
    failures: add(row => row.failures), unattributable: add(row => row.unattributable) });
}
