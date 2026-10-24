import { MEMORY_LIMITS, composeMemoryAutomation, encodeCommandProjection, independentMakerRows, isMemoryEvaluatorPrincipal, memorySearchTerms, memoryTemplate, parseMemoryEvaluationRecord,
  readMemoryEvaluatorAnswer, memoryContestTargets, isMemoryTombstone, type AuditEvent, type MemoryAutomation, type MemoryEntry, type MemoryContent, type MemoryEvaluationRecord, type MemoryEvaluationRef,
  type MemoryEvaluationSpend, type MemoryModelRef, type MemoryResolvedEvaluation, type ModelInvocationReceipt, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { verifyInvocationSpendReservation } from '#engine/core/provider-spend/index.js';
import { MemoryJournalError, type MemoryEvaluationAlertKey, type MemoryEvaluationPass, type MemoryEvaluationSkip, type MemoryEvaluationSource, type MemoryEvaluationSources, type MemoryEvaluatorPorts,
  type MemoryEvaluatorRow, type MemoryJournalDependencies, type MemoryJournalStore } from './contract.js';

const DAY_MS = 86_400_000, TEMPLATE = Object.freeze({ id: 'evaluate', version: 1 });
const BILLING_ORDER = Object.freeze(['subscription', 'local', 'metered']);
export const memoryEvaluationDigest = (record: MemoryEvaluationRecord) => sha256(encodeCommandProjection('memory-evaluation-record:1', record));
const modelKey = (model: MemoryModelRef) => JSON.stringify([model.channelId, model.modelId, model.maker]);

/**
 * S4B-3 §6.3: the source worker models of an entry, re-derived from the sealed Run of each support row's Attempt (never the support row's own
 * claim). Any source gone, not accepted or unsettled, no support port or no sources port: null (verification fails closed).
 */
export async function rederiveMemorySourceModels(store: MemoryJournalStore, sources: MemoryEvaluationSources | undefined, automation: MemoryAutomation, entry: MemoryEntry) {
  if (!sources || !store.listSupport || !entry.audience) return null;
  const rows = await store.listSupport(entry.scopeId, entry.entryId, automation.bounds.supportPerEntry), models = new Map<string, MemoryModelRef>();
  const attempts: { runId: string; taskId: string; attemptId: string }[] = [], evidence = new Map<string, MemoryEvaluationSource['criteria']>();
  for (const row of rows) {
    const source = await sources.source(entry.scopeId, row.source);
    if (!source || !source.accepted || !source.settled) return null;
    for (const model of source.models) models.set(modelKey(model), model);
    if (!attempts.some(item => item.attemptId === row.source.attemptId && item.runId === row.source.runId)) attempts.push({ ...row.source });
    evidence.set(source.evaluationId, source.criteria);
  }
  return rows.length ? { models: [...models.values()], attempts, evaluationIds: [...evidence.keys()],
    evidence: [...evidence].map(([evaluationId, criteria]) => ({ evaluationId, criteria })) } : null;
}
/** §6.2 step 5 resolver (wired for the evaluator path only): a sealed `memory-evaluation` record of this scope whose digest is the one cited. */
export const memoryEvaluationResolver = (openStore: MemoryJournalDependencies['openStore']) => async (scopeId: string, ref: MemoryEvaluationRef): Promise<MemoryResolvedEvaluation | null> => {
  if (ref.kind !== 'memory-evaluation') return null;
  const store = await openStore('read');
  try {
    const held = await store.loadEvaluation?.(scopeId, ref.id);
    if (!held || held.digest !== ref.digest || memoryEvaluationDigest(held.record) !== held.digest || held.record.scopeId !== scopeId) return null;
    const { record } = held;
    return { record: ref, evaluator: record.evaluator, verdict: record.verdict, subjectDigest: record.subjectDigest, mode: record.mode, evaluatorModel: record.evaluatorModel, sourceModels: record.sourceModels };
  } finally { store.close(); }
};
/** §6.2 step 2: the independent rows (canonical maker differs from every source maker), subscription channels first, then registry order. */
export function selectMemoryEvaluator(rows: readonly MemoryEvaluatorRow[], sources: readonly MemoryModelRef[]): MemoryEvaluatorRow | null {
  const eligible = independentMakerRows(rows.filter(row => row.invocable), row => row.maker, sources.map(model => model.maker));
  const rank = (row: MemoryEvaluatorRow) => { const index = BILLING_ORDER.indexOf(row.billing ?? ''); return index < 0 ? BILLING_ORDER.length : index; };
  return [...eligible].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
/** Today's (UTC) evaluator use of the scope from its own sealed records: calls, unknown answers, settled spend; a call of unknown spend or mixed
 * currencies stops spending (fail closed). */
function dailyUse(records: readonly MemoryEvaluationRecord[], sinceMs: number) {
  const today = records.filter(record => record.atMs >= sinceMs), settled = today.flatMap(record => record.spend.state === 'settled' ? [record.spend] : []);
  return { calls: today.length, unknown: today.filter(record => record.verdict === 'unknown').length, minorUnits: settled.reduce((sum, spend) => sum + spend.minorUnits, 0),
    spendUnknown: today.some(record => record.spend.state === 'unknown') || new Set(settled.map(spend => spend.currency)).size > 1 };
}

/** The daily cap the scope has reached (calls, the unknown-answer breaker, settled or unknown spend), or null. */
function capped(records: readonly MemoryEvaluationRecord[], now: number, automation: MemoryAutomation): MemoryEvaluationAlertKey | null {
  const use = dailyUse(records, now - now % DAY_MS), bounds = automation.evaluation;
  if (use.calls >= bounds.perScopePerDay) return 'memory.alert.evaluationDailyCap';
  if (use.unknown >= bounds.unknownPerScopePerDay) return 'memory.alert.evaluatorBreaker';
  if (use.spendUnknown || use.minorUnits >= bounds.spendMinorUnitsPerScopePerDay) return 'memory.alert.spendCap';
  return null;
}
export interface MemoryEvaluationDependencies {
  readonly deps: MemoryJournalDependencies;
  readonly evaluator: MemoryEvaluatorPorts;
  /** The evaluator's own principal (composition root identity). */
  readonly principal: VerifiedPrincipal;
  /** The journal transition owner's verify (live mode only). */
  verify(command: unknown): Promise<unknown>;
}
type Candidate = { readonly entry: MemoryEntry; readonly recordId: string };
/**
 * S4B-3 §6.2 (owner S-M3/S-M4/S-M5/S-M10): one bounded evaluator pass over a scope's system candidates, off the hot path. Deterministic gate first
 * (system entry, every source still accepted and settled, makers known), then one independent evaluator row (none: no call, no record — N29),
 * then the daily call/unknown/spend caps, one call with retries 0, the strict answer, one sealed record. `shadow` stops there; `live` verifies a
 * pass through the journal and opens bounded contests. A record per (entry revision, mode) is never asked again (N20: a live pass found sealed
 * but not yet applied is applied without a second call).
 */
export class MemoryEvaluationApplication {
  constructor(private readonly ports: MemoryEvaluationDependencies) {}
  async evaluatePage(scopeId: string, mode: 'shadow' | 'live'): Promise<MemoryEvaluationPass> {
    const { deps, principal } = this.ports;
    if (!isMemoryEvaluatorPrincipal(principal) || !principal.scopeIds.includes(scopeId)) throw new MemoryJournalError('MEMORY_EVALUATOR_REQUIRED');
    await deps.authorize('inspect', scopeId, principal);
    const automation = composeMemoryAutomation(deps.automation), pass = { calls: 0, records: [] as MemoryEvaluationPass['records'][number][],
      skipped: [] as { entryId: string; reason: MemoryEvaluationSkip }[], alerts: [] as { key: MemoryEvaluationAlertKey; scopeId: string }[] };
    const store = await deps.openStore('read');
    let candidates: Candidate[], stop: MemoryEvaluationAlertKey | null, rows: readonly MemoryEvaluatorRow[];
    try {
      if (!store.putEvaluation || !store.loadEvaluation || !store.recentEvaluations || !store.listSupport || !store.openContest || !store.contestCount) throw new MemoryJournalError('MEMORY_UNAVAILABLE');
      // No invocable evaluator row in the scope: nothing to examine this pass (N29 before any candidate is read).
      rows = (await this.ports.evaluator.rows(scopeId)).filter(row => row.invocable);
      if (!rows.length) return Object.freeze({ schemaVersion: 1, mode, ...pass });
      stop = capped(await store.recentEvaluations(scopeId, automation.evaluation.perScopePerDay + 1), deps.now(), automation);
      // The scan window (protocol `scanMax`, newest first): evaluated candidates stay candidates, so a page-sized list would starve older ones.
      candidates = stop ? [] : (await store.list(scopeId, ['candidate'], MEMORY_LIMITS.scanMax)).map(entry => ({ entry,
        recordId: deps.keyedDigest('memory-evaluation:1', { scopeId, entryId: entry.entryId, revision: entry.revision, mode }) }));
    } finally { store.close(); }
    for (const candidate of candidates) {
      if (pass.calls >= automation.bounds.loopPage) break;
      stop = await this.evaluate(candidate, mode, automation, rows, pass);
      if (stop) break;
    }
    if (stop) pass.alerts.push({ key: stop, scopeId });
    return Object.freeze({ schemaVersion: 1, mode, ...pass });
  }
  /** One candidate; returns the alert key that stops the pass (a daily cap reached), else null. */
  private async evaluate(candidate: Candidate, mode: 'shadow' | 'live', automation: MemoryAutomation, rows: readonly MemoryEvaluatorRow[], pass: { calls: number; records: unknown[];
    skipped: { entryId: string; reason: MemoryEvaluationSkip }[] }): Promise<MemoryEvaluationAlertKey | null> {
    const { deps } = this.ports, { entry } = candidate, skip = (reason: MemoryEvaluationSkip) => { pass.skipped.push({ entryId: entry.entryId, reason }); return null; };
    if (!entry.audience) return skip('not-system');
    // S4B-4: a purged candidate has no text left; it is never sent to any model.
    if (isMemoryTombstone(entry.content)) return skip('purged');
    const store = await deps.openStore('read');
    let prepared;
    try {
      const sealed = await store.loadEvaluation!(entry.scopeId, candidate.recordId);
      // Never asked twice (N20): only a sealed live pass not yet applied is applied, without a second call.
      if (sealed) return mode === 'live' && sealed.record.verdict === 'pass' ? this.apply(sealed.record, sealed.digest, automation, pass) : skip('evaluated');
      const subjectDigest = deps.keyedDigest('memory-content:2', entry.content);
      if (subjectDigest !== entry.contentDigest) return skip('source-not-accepted');
      const sources = await rederiveMemorySourceModels(store, deps.evaluationSources, automation, entry);
      if (!sources) return skip('source-not-accepted');
      if (sources.models.length === 0 || sources.models.some(model => model.maker === null)) return skip('maker-unknown');
      const row = selectMemoryEvaluator(rows, sources.models);
      if (!row || row.maker === null) return skip('no-independent-evaluator');
      const stop = capped(await store.recentEvaluations!(entry.scopeId, automation.evaluation.perScopePerDay + 1), deps.now(), automation);
      if (stop) return stop;
      prepared = { sources, subjectDigest, row: { ...row, maker: row.maker }, content: entry.content, titles: await this.conflictTitles(store, { ...entry, content: entry.content }, automation) };
    } finally { store.close(); }
    const record = await this.call(candidate, mode, automation, prepared);
    pass.calls++;
    return this.apply(record, memoryEvaluationDigest(record), automation, pass, true);
  }
  /** §6.2 step 3: verified entries of the same audience that share a term with the candidate (one bounded search per term: a contradiction rarely
   * repeats every word), ids and titles only (never their bodies). */
  private async conflictTitles(store: MemoryJournalStore, entry: MemoryEntry & { readonly content: MemoryContent }, automation: MemoryAutomation) {
    const terms = memorySearchTerms(`${entry.content.title} ${entry.content.body}`), max = automation.evaluation.conflictTitles, out = new Map<string, string>();
    if (!store.capabilities.fullTextSearch || !store.search) return [];
    for (const term of terms) {
      for (const id of (await store.search(entry.scopeId, [term], ['verified'], max)).slice(0, max)) {
        const other = out.size < max && !out.has(id) ? await store.load(entry.scopeId, id) : null;
        if (other?.state === 'verified' && !isMemoryTombstone(other.content) && JSON.stringify(other.audience ?? null) === JSON.stringify(entry.audience)) out.set(other.entryId, other.content.title);
      }
    }
    return [...out].map(([entryId, title]) => ({ entryId, title }));
  }
  private async call(candidate: Candidate, mode: 'shadow' | 'live', automation: MemoryAutomation,
    prepared: { sources: NonNullable<Awaited<ReturnType<typeof rederiveMemorySourceModels>>>; subjectDigest: string; row: MemoryEvaluatorRow & { maker: string };
      content: MemoryContent; titles: readonly { entryId: string; title: string }[] }) {
    const { deps, principal } = this.ports, { entry } = candidate, kd = deps.keyedDigest, { subjectDigest } = prepared;
    const data = { schemaVersion: 1, answerSchema: { schemaVersion: 1, entryId: 'string', subjectDigest: 'string', verdict: 'pass|fail|unknown', reasonCodes: 'string[]', conflicts: 'string[]' },
      reasonCodes: automation.reasonCodes, entryId: entry.entryId, subjectDigest, candidate: { kind: prepared.content.kind, title: prepared.content.title, body: prepared.content.body, lesson: prepared.content.lesson },
      evidence: prepared.sources.evidence, verifiedTitles: prepared.titles };
    const messages = [{ role: 'system' as const, content: memoryTemplate(TEMPLATE.id, TEMPLATE.version) }, { role: 'user' as const, content: JSON.stringify(data) }];
    const result = await this.ports.evaluator.invoke({ scopeId: entry.scopeId, commandId: candidate.recordId, row: prepared.row, messages, maxCompletionTokens: automation.evaluation.maxCompletionTokens });
    const answer = result.status === 'responded' ? readMemoryEvaluatorAnswer(result.text, { entryId: entry.entryId, subjectDigest, offered: prepared.titles.map(item => item.entryId) }, automation)
      : { verdict: 'unknown' as const, reasonCodes: [], conflicts: [], failure: result.code };
    return parseMemoryEvaluationRecord({ schemaVersion: 1, recordId: candidate.recordId, scopeId: entry.scopeId, entryId: entry.entryId, entryRevision: entry.revision, subjectDigest, mode,
      method: 'model-review', evaluator: { issuer: principal.issuer, subject: principal.subject },
      evaluatorModel: { channelId: prepared.row.channelId, modelId: prepared.row.modelId, maker: prepared.row.maker }, sourceModels: prepared.sources.models,
      sourceAttempts: prepared.sources.attempts, sourceEvaluationIds: prepared.sources.evaluationIds, template: TEMPLATE, registryRevision: automation.revision,
      inputDigest: kd('memory-evaluation-input:1', messages), outputDigest: result.status === 'responded' ? kd('memory-evaluation-output:1', result.text) : null,
      invocationId: result.invocationId, spend: result.spend, ...answer, atMs: deps.now() });
  }
  private event(record: MemoryEvaluationRecord, subject: AuditEvent['subject']): AuditEvent {
    const { deps, principal } = this.ports;
    return { schemaVersion: 1, eventId: deps.eventId(), scopeId: record.scopeId, principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: record.registryRevision,
      atMs: deps.now(), subject };
  }
  /** Seal (when new), then in live mode verify a pass through the journal and open its bounded contests. */
  private async apply(record: MemoryEvaluationRecord, digest: string, automation: MemoryAutomation, pass: { records: unknown[] }, fresh = false): Promise<MemoryEvaluationAlertKey | null> {
    const { deps } = this.ports, store = await deps.openStore('write');
    try {
      if (fresh) await store.putEvaluation!(record, digest, this.event(record, { kind: 'memory-evaluation', recordId: record.recordId, entryId: record.entryId,
        revision: record.entryRevision, mode: record.mode, verdict: record.verdict, recordDigest: digest, subjectDigest: record.subjectDigest }));
    } finally { store.close(); }
    let verified = false, contests = 0, alert: MemoryEvaluationAlertKey | null = null;
    if (record.mode === 'live' && record.verdict === 'pass') {
      const current = await this.current(record);
      if (current?.state === 'candidate' && current.revision === record.entryRevision) {
        await this.ports.verify({ schemaVersion: 1, scopeId: record.scopeId, commandId: record.recordId, entryId: record.entryId, expectedRevision: record.entryRevision,
          basis: { kind: 'independent-evaluation', record: { kind: 'memory-evaluation', id: record.recordId, digest } } });
        verified = true;
      }
      ({ contests, alert } = await this.contest(record, digest, automation));
    }
    pass.records.push({ entryId: record.entryId, recordId: record.recordId, verdict: record.verdict, verified, contests });
    return alert;
  }
  private async current(record: MemoryEvaluationRecord) {
    const store = await this.ports.deps.openStore('read');
    try { return await store.load(record.scopeId, record.entryId); } finally { store.close(); }
  }
  /** A9/§6.5: each conflict of a pass withdraws one verified entry (bounded per scope per day; past the bound one alert, the rest not opened). */
  private async contest(record: MemoryEvaluationRecord, digest: string, automation: MemoryAutomation) {
    const targets = memoryContestTargets(record), { deps, principal } = this.ports;
    if (!targets.length) return { contests: 0, alert: null };
    await deps.authorize('contest', record.scopeId, principal);
    const store = await deps.openStore('write');
    let contests = 0;
    try {
      const now = deps.now();
      for (const entryId of targets) {
        const target = await store.load(record.scopeId, entryId);
        if (target?.state !== 'verified') continue;
        if (await store.contestCount!(record.scopeId, now - now % DAY_MS) >= automation.evaluation.contestsPerScopePerDay) return { contests, alert: 'memory.alert.contestBound' as const };
        const contestId = deps.keyedDigest('memory-contest:1', { scopeId: record.scopeId, entryId, recordId: record.recordId });
        const opened = await store.openContest!({ schemaVersion: 1, contestId, scopeId: record.scopeId, entryId, candidateEntryId: record.entryId, evaluationRecordId: record.recordId,
          evaluationDigest: digest, openedBy: { issuer: principal.issuer, subject: principal.subject }, reasonCode: 'contradicts-verified', openedAtMs: now },
        this.event(record, { kind: 'memory-contest', contestId, entryId, candidateEntryId: record.entryId, recordId: record.recordId }));
        if (!opened.replayed) contests++;
      }
    } finally { store.close(); }
    return { contests, alert: null };
  }
}
/**
 * The exact spend of one evaluator call from its sealed invocation and spend reservation (the provider-spend ledger's own verified record):
 * released (not sent, rejected without charge) → none; settled → the settled minor units in the reservation's currency; a subscription or local
 * profile without a reservation → none; anything else (reserved, held, unreadable) → unknown, which stops the evaluator for the day.
 */
export function memoryEvaluationSpendOf(stored: { readonly receipt: ModelInvocationReceipt; readonly spending: unknown } | null, billing: MemoryEvaluatorRow['billing']): MemoryEvaluationSpend {
  if (!stored) return { state: 'unknown' };
  if (stored.spending === null) return billing === 'subscription' || billing === 'local' ? { state: 'none' } : { state: 'unknown' };
  let reservation;
  try { reservation = verifyInvocationSpendReservation(stored.spending, stored.receipt); } catch { return { state: 'unknown' }; }
  const state = reservation.disposition;
  if (state.state === 'released-not-sent' || state.state === 'released-no-charge') return { state: 'none' };
  if (state.state === 'settled-local' || state.state === 'settled-measured-tariff' || state.state === 'settled-provider-reported')
    return { state: 'settled', minorUnits: state.amountMinorUnits, currency: reservation.descriptor.currency };
  return { state: 'unknown' };
}
