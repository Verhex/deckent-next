import { z } from 'zod';
import rolloutSeed from '../../../../../assets/memory/rollout.json' with { type: 'json' };
import corpusSeed from '../../../../../assets/memory/injection-corpus.json' with { type: 'json' };
import { assertMemoryEvaluationIndependent, composeMemoryAutomation, identitySchema, rolloutCriterionMet, isMemoryTombstone, memoryEntryStale, memoryRetentionMs, type AuditEvent, type MemoryAutomation,
  type MemoryEntry, type MemoryEvaluationRecord } from '#domain/index.js';
import { MEMORY_AUTOMATION_MODES } from '#platform/index.js';
import { MemoryJournalError, type MemoryJournalDependencies, type MemoryJournalStore } from './contract.js';
import { screenMemoryCandidate } from './distil.js';
import { rederiveMemorySourceModels } from './evaluate.js';

/**
 * S4B-7 (S4B-DESIGN rev 4 §10, §11, §13; owner S-M14 2026-10-23): the memory rollout. The phases are the `memoryAutomation` switches in order
 * (versioned Core data, `assets/memory/rollout.json`, provisional until measured on a real installation); the two live switches (phase 3: verified entries reach
 * the models; phase 4: the independent evaluator verifies) carry exit criteria measured only from sealed records. Meeting them only allows a
 * person's switch; nothing here enables anything. Ratios are integers per mille (no floating comparison decides a gate).
 */
export const MEMORY_ROLLOUT_METRICS = Object.freeze(['agreement', 'decided-since-false-pass', 'corpus', 'independence-violations', 'contest-rate', 'context-shadow-runs',
  'context-overflow', 'context-integrity-violations', 'candidate-secret-findings', 'purge-replay-pending'] as const);
export type MemoryRolloutMetric = typeof MEMORY_ROLLOUT_METRICS[number];
export const MEMORY_ROLLOUT_SECTIONS = Object.freeze(['extraction', 'verification', 'context'] as const);
export type MemoryRolloutSection = typeof MEMORY_ROLLOUT_SECTIONS[number];
export type MemoryRolloutModes = Readonly<Record<MemoryRolloutSection, typeof MEMORY_AUTOMATION_MODES[number]>>;
const PER_MILLE = 1000;
const count = z.number().int().nonnegative().safe(), perMille = z.number().int().min(0).max(PER_MILLE);
const criterionSchema = z.object({ id: identitySchema, metric: z.enum(MEMORY_ROLLOUT_METRICS), minSample: count.optional(), minPerMille: perMille.optional(),
  maxPerMille: perMille.optional(), maxCount: count.optional() }).strict().readonly();
const phaseSchema = z.object({ phase: count, section: z.enum(MEMORY_ROLLOUT_SECTIONS), set: z.enum(MEMORY_AUTOMATION_MODES), reached: z.array(z.enum(MEMORY_AUTOMATION_MODES)).min(1).readonly(),
  criteria: z.array(identitySchema).max(32).readonly() }).strict().refine(phase => phase.reached.includes(phase.set)).readonly();
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'measured']),
  /** The newest sealed records read per source (an audit page and the store reads are bounded; `complete` false when more exist). */
  scan: z.object({ evaluations: count.positive(), contextEvents: count.positive(), candidates: count.positive() }).strict().readonly(),
  phases: z.array(phaseSchema).min(1).max(16).readonly(), criteria: z.array(criterionSchema).min(1).max(32).readonly() }).strict()
  .refine(registry => registry.phases.every((phase, index) => index === 0 || phase.phase > registry.phases[index - 1]!.phase)
    && new Set(registry.criteria.map(row => row.id)).size === registry.criteria.length
    && registry.phases.every(phase => phase.criteria.every(id => registry.criteria.some(row => row.id === id)))).readonly();
export type MemoryRolloutRegistry = z.infer<typeof registrySchema>;
export type MemoryRolloutCriterion = MemoryRolloutRegistry['criteria'][number];
export const MEMORY_ROLLOUT: MemoryRolloutRegistry = Object.freeze(registrySchema.parse(rolloutSeed));
const corpusSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, note: z.string(), items: z.array(z.object({ id: identitySchema, kind: identitySchema,
  title: z.string().min(1), body: z.string().min(1) }).strict().readonly()).min(1).max(256).readonly() }).strict().readonly();
/** N28 (§8): the versioned poisoning corpus; the phase 4 gate counts its items' shadow evaluations on the installation. */
export const MEMORY_INJECTION_CORPUS = Object.freeze(corpusSchema.parse(corpusSeed));
/** One corpus item as the distiller writes a worker `fact` claim (rule E3): the content whose keyed digest a shadow record names. */
export const memoryCorpusContent = (item: { readonly title: string; readonly body: string }) => ({ kind: 'fact' as const, title: item.title, body: item.body, tags: [], lesson: null });

/** One measured value: `count` of `sample` (and of `of` when the whole of a known set is required); `complete` false when the scan bound was hit. */
export interface MemoryRolloutMeasure { readonly count: number; readonly sample: number; readonly of: number | null; readonly complete: boolean }
/** null: the source could not be read (the criterion is then unmet — never assumed). */
export type MemoryRolloutMeasures = Readonly<Partial<Record<MemoryRolloutMetric, MemoryRolloutMeasure | null>>>;
const measure = (value: number, sample: number, complete: boolean, of: number | null = null): MemoryRolloutMeasure => Object.freeze({ count: value, sample, of, complete });
export const memoryRolloutCriterionMet: (criterion: MemoryRolloutCriterion, value: MemoryRolloutMeasure | null | undefined) => boolean = rolloutCriterionMet;
export interface MemoryRolloutCriterionView { readonly criterion: MemoryRolloutCriterion; readonly measure: MemoryRolloutMeasure | null; readonly met: boolean }
export interface MemoryRolloutPhaseView { readonly phase: number; readonly section: MemoryRolloutSection; readonly set: typeof MEMORY_AUTOMATION_MODES[number]; readonly reached: boolean; readonly met: boolean;
  readonly criteria: readonly MemoryRolloutCriterionView[] }
/** `phase`: the highest consecutive phase whose switch is set (null: the first is missing); `next`: the first phase not yet set; `liveUnmet`: phases set whose criteria do not hold now. */
export interface MemoryRolloutView { readonly phase: number | null; readonly next: MemoryRolloutPhaseView | null; readonly phases: readonly MemoryRolloutPhaseView[]; readonly liveUnmet: readonly number[] }
const reachedIn = (phase: MemoryRolloutRegistry['phases'][number], modes: MemoryRolloutModes) => phase.reached.includes(modes[phase.section]);
export function memoryRolloutView(modes: MemoryRolloutModes, measures: MemoryRolloutMeasures, registry: MemoryRolloutRegistry = MEMORY_ROLLOUT): MemoryRolloutView {
  const phases = registry.phases.map(phase => {
    const criteria = phase.criteria.map(id => { const criterion = registry.criteria.find(row => row.id === id)!, value = measures[criterion.metric] ?? null;
      return Object.freeze({ criterion, measure: value, met: memoryRolloutCriterionMet(criterion, value) }); });
    return Object.freeze({ phase: phase.phase, section: phase.section, set: phase.set, reached: reachedIn(phase, modes), met: criteria.every(row => row.met), criteria: Object.freeze(criteria) });
  });
  const reached = phases.filter(phase => phase.reached), missing = phases.findIndex(phase => !phase.reached);
  return Object.freeze({ phase: (missing < 0 ? phases.at(-1) : phases[missing - 1])?.phase ?? null, next: missing < 0 ? null : phases[missing]!, phases: Object.freeze(phases),
    liveUnmet: Object.freeze(reached.filter(phase => !phase.met).map(phase => phase.phase)) });
}
/** The gated phases (those with criteria) a change from `before` to `after` newly sets; empty: nothing to measure. A step back is never gated. */
export const memoryRolloutGated = (before: MemoryRolloutModes, after: MemoryRolloutModes, registry: MemoryRolloutRegistry = MEMORY_ROLLOUT): readonly number[] =>
  registry.phases.filter(phase => phase.criteria.length > 0 && reachedIn(phase, after) && !reachedIn(phase, before)).map(phase => phase.phase);

/** S4B-7 read ports beyond the journal store: sealed audit subjects of one kind in the scope, newest first, at most `limit` (verified seals). */
export interface MemoryRolloutPorts {
  contextEvents(scopeId: string, kind: 'memory-context' | 'brain-memory-context', limit: number): Promise<readonly AuditEvent['subject'][]>;
}
/** §6.5 retention as the rollout shows it: the provisional registry rows and what the scope's verified entries measure against them. */
export interface MemoryRolloutRetention { readonly revision: string; readonly status: 'provisional' | 'measured';
  readonly rows: readonly { readonly workClassId: string; readonly profileId: string; readonly entryMaxAgeMs: number }[];
  readonly verified: number; readonly stale: number; readonly oldestSupportAgeMs: number | null; readonly complete: boolean }
export interface MemoryRolloutStatus { readonly schemaVersion: 1; readonly status: 'ok'; readonly scopeId: string; readonly registry: { readonly revision: string; readonly status: 'provisional' | 'measured' };
  readonly modes: MemoryRolloutModes; readonly view: MemoryRolloutView; readonly corpus: { readonly revision: string; readonly items: number };
  readonly retention: MemoryRolloutRetention | null }
const unavailable = () => new MemoryJournalError('MEMORY_UNAVAILABLE');
const readOr = async <T>(work: () => Promise<T>): Promise<T | null> => { try { return await work(); } catch { return null; } };

/** A person's decision on an entry, and when: verified on review (kept, or later replaced by a newer entry or purged on expiry) is accept; retired or purged otherwise is reject. */
function personDecision(entry: MemoryEntry): { readonly accept: boolean; readonly atMs: number } | null {
  const human = entry.verification?.basis === 'human-review' ? entry.verification.verifiedAtMs : null, purged = isMemoryTombstone(entry.content) ? entry.content.reasonCode : null;
  if (entry.retirement && !entry.retirement.by.ai) return human !== null && entry.retirement.supersededBy !== null ? { accept: true, atMs: human } : { accept: false, atMs: entry.retirement.retiredAtMs };
  if (purged !== null) return human !== null && purged === 'expired' ? { accept: true, atMs: human } : { accept: false, atMs: entry.updatedAtMs };
  return human === null ? null : { accept: true, atMs: human };
}
/**
 * §11 evaluator criteria from the sealed shadow records (newest first): per entry the newest decisive (`pass`/`fail`) record sealed before the
 * person's decision is compared with it (a decision made before any record is not a blind comparison and is not counted). A false pass is a
 * `pass` the person rejected; it — and any `pass` on a corpus item — resets the count of decided candidates since. Independence is re-checked
 * against the source models re-derived from the sealed Runs (N22); a record whose sources can no longer be re-derived is not provable and counts.
 */
async function evaluatorMeasures(deps: MemoryJournalDependencies, store: MemoryJournalStore, scopeId: string, registry: MemoryRolloutRegistry, automation: MemoryAutomation) {
  if (!store.recentEvaluations) throw unavailable();
  const page = await store.recentEvaluations(scopeId, registry.scan.evaluations), complete = page.length < registry.scan.evaluations;
  if (page.some(record => record.scopeId !== scopeId)) throw new MemoryJournalError('MEMORY_CORRUPT');
  const shadow = page.filter(record => record.mode === 'shadow'), entries = new Map<string, MemoryEntry | null>();
  const entryOf = async (id: string) => { if (!entries.has(id)) entries.set(id, await store.load(scopeId, id)); return entries.get(id)!; };
  const items = MEMORY_INJECTION_CORPUS.items, corpus = new Map(items.map(item => [deps.keyedDigest('memory-content:2', memoryCorpusContent(item)), item.id] as const));
  const covered = new Set(items.filter(item => screenMemoryCandidate(memoryCorpusContent(item), deps.knownSecrets) !== null).map(item => item.id));
  let corpusPasses = 0, resetAt = -1;
  for (const record of shadow) {
    const id = corpus.get(record.subjectDigest);
    if (id === undefined) continue;
    covered.add(id);
    if (record.verdict === 'pass') { corpusPasses++; resetAt = Math.max(resetAt, record.atMs); }
  }
  const decided: { readonly agree: boolean; readonly falsePass: boolean; readonly atMs: number }[] = [], seen = new Set<string>();
  for (const record of shadow) {
    if (record.verdict === 'unknown' || seen.has(record.entryId)) continue;
    const entry = await entryOf(record.entryId), decision = entry && personDecision(entry);
    if (!decision || decision.atMs < record.atMs) continue;
    seen.add(record.entryId);
    const falsePass = record.verdict === 'pass' && !decision.accept;
    decided.push({ agree: (record.verdict === 'pass') === decision.accept, falsePass, atMs: decision.atMs });
    if (falsePass) resetAt = Math.max(resetAt, decision.atMs);
  }
  const independence = await readOr(async () => {
    if (!deps.evaluationSources) throw unavailable();
    const derived = new Map<string, Awaited<ReturnType<typeof rederiveMemorySourceModels>>>();
    let violations = 0;
    for (const record of shadow) {
      if (!derived.has(record.entryId)) { const entry = await entryOf(record.entryId);
        derived.set(record.entryId, entry ? await rederiveMemorySourceModels(store, deps.evaluationSources, automation, entry) : null); }
      try { assertMemoryEvaluationIndependent(record, derived.get(record.entryId)?.models ?? null); } catch { violations++; }
    }
    return measure(violations, shadow.length, complete);
  });
  const decisive = shadow.filter((record: MemoryEvaluationRecord) => record.verdict !== 'unknown');
  return { agreement: measure(decided.filter(row => row.agree).length, decided.length, complete),
    'decided-since-false-pass': measure(decided.filter(row => row.falsePass).length, decided.filter(row => row.atMs > resetAt).length, complete),
    corpus: measure(corpusPasses, covered.size, complete, items.length), 'independence-violations': independence,
    'contest-rate': measure(decisive.filter(record => record.verdict === 'pass' && record.conflicts.length > 0).length, decisive.length, complete) };
}
/**
 * §11 context criteria from the sealed `memory-context` events of shadow admissions: distinct Runs whose event says whether the part fit the
 * prompt (events sealed before `fit` existed do not count), parts that would not have fit, and every entry an event names (worker and Brain)
 * re-checked against the journal: present in this scope at that revision, verified on the sealed basis with the sealed keyed digest, and (N10)
 * never derived from the Run it served.
 */
async function contextMeasures(store: MemoryJournalStore, scopeId: string, registry: MemoryRolloutRegistry, automation: MemoryAutomation, ports: MemoryRolloutPorts) {
  if (!store.listSupport) throw unavailable();
  const limit = registry.scan.contextEvents, worker = await ports.contextEvents(scopeId, 'memory-context', limit), brain = await ports.contextEvents(scopeId, 'brain-memory-context', limit);
  const complete = worker.length < limit && brain.length < limit;
  const shadow = worker.flatMap(subject => subject.kind === 'memory-context' && subject.mode === 'shadow' ? [subject] : []), fitted = shadow.filter(subject => subject.fit !== undefined);
  const named = [...shadow.map(subject => ({ runId: subject.runId, worker: true, entries: subject.entries })),
    ...brain.flatMap(subject => subject.kind === 'brain-memory-context' && subject.mode === 'shadow' ? [{ runId: subject.runId, worker: false, entries: subject.entries }] : [])];
  let violations = 0, checked = 0;
  for (const event of named) for (const ref of event.entries) {
    checked++;
    const revision = await store.loadRevision(scopeId, ref.entryId, ref.revision);
    let bad = !revision || revision.scopeId !== scopeId || revision.state !== 'verified' || revision.contentDigest !== ref.contentDigest || revision.verification?.basis !== ref.basis;
    if (!bad && event.worker && revision!.audience) bad = (await store.listSupport(scopeId, ref.entryId, automation.bounds.supportPerEntry)).some(row => row.source.runId === event.runId);
    if (bad) violations++;
  }
  const runs = new Set(fitted.map(subject => subject.runId)).size;
  return { 'context-shadow-runs': measure(runs, runs, complete), 'context-overflow': measure(fitted.filter(subject => subject.fit === false).length, fitted.length, complete),
    'context-integrity-violations': measure(violations, checked, complete) };
}
async function retentionOf(deps: MemoryJournalDependencies, store: MemoryJournalStore, scopeId: string, automation: MemoryAutomation): Promise<MemoryRolloutRetention> {
  const limit = automation.context.candidatePool, pool = await store.list(scopeId, ['verified'], limit), now = deps.now();
  let stale = 0, oldest: number | null = null;
  for (const entry of pool) {
    const support = entry.audience && store.listSupport ? await store.listSupport(scopeId, entry.entryId, automation.bounds.supportPerEntry) : [];
    const last = support.length ? Math.max(...support.map(row => row.atMs)) : null;
    if (memoryEntryStale(entry, last, memoryRetentionMs(automation, entry), now)) stale++;
    oldest = Math.max(oldest ?? 0, now - Math.max(last ?? 0, entry.provenance.proposedAtMs));
  }
  return Object.freeze({ revision: automation.revision, status: automation.status, rows: Object.freeze(automation.workClasses.map(row => Object.freeze({ workClassId: row.workClassId,
    profileId: row.retentionProfile.id, entryMaxAgeMs: row.retentionProfile.entryMaxAgeMs }))), verified: pool.length, stale, oldestSupportAgeMs: oldest, complete: pool.length < limit });
}
/** Every rollout measure of one scope over one open store; each source that cannot be read is null (its criteria unmet), never a default. */
export async function measureMemoryRollout(deps: MemoryJournalDependencies, store: MemoryJournalStore, scopeId: string, modes: MemoryRolloutModes, ports: MemoryRolloutPorts,
  registry: MemoryRolloutRegistry = MEMORY_ROLLOUT): Promise<MemoryRolloutStatus> {
  const automation = composeMemoryAutomation(deps.automation);
  const evaluator = await readOr(() => evaluatorMeasures(deps, store, scopeId, registry, automation)), context = await readOr(() => contextMeasures(store, scopeId, registry, automation, ports));
  const candidates = await readOr(async () => {
    const rows = await store.list(scopeId, ['candidate'], registry.scan.candidates);
    return measure(rows.filter(entry => !isMemoryTombstone(entry.content) && screenMemoryCandidate(entry.content, deps.knownSecrets) !== null).length, rows.length, rows.length < registry.scan.candidates);
  });
  const purges = await readOr(async () => {
    if (!deps.purgeJournal || !store.purgeRecord) throw unavailable();
    const records = (await deps.purgeJournal.list()).filter(record => record.scopeId === scopeId);
    let pending = 0;
    for (const record of records) if (!await store.purgeRecord(scopeId, record.purgeId)) pending++;
    return measure(pending, records.length, true);
  });
  const measures: MemoryRolloutMeasures = { ...(evaluator ?? {}), ...(context ?? {}), 'candidate-secret-findings': candidates, 'purge-replay-pending': purges };
  return Object.freeze({ schemaVersion: 1, status: 'ok', scopeId, registry: { revision: registry.revision, status: registry.status }, modes, view: memoryRolloutView(modes, measures, registry),
    corpus: { revision: MEMORY_INJECTION_CORPUS.revision, items: MEMORY_INJECTION_CORPUS.items.length }, retention: await readOr(() => retentionOf(deps, store, scopeId, automation)) });
}
