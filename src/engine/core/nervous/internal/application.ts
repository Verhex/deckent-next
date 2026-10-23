import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_ACTIONS, auditEventSchema, identitySchema, nervousPrincipalRef, type AuditEvent, type AuditRecord } from '#domain/index.js';
import { NervousError, loadNervousRules, type NervousRules } from './rules.js';
import { advanceNervousAbsence, detectNervousAttempt, detectNervousFeed, detectNervousOutage, nervousAttemptSignalSchema, nervousProposalSchema,
  type NervousAbsence, type NervousAttemptSignal, type NervousFeedKind, type NervousProposal } from './detect.js';
import { nervousDisposition, type NervousDisposition, type NervousExecutors } from './broker.js';

/** The one audit writer (seal before any effect; an existing case is a replay) and the trusted wall clock. Nervous holds no other write port. */
export interface NervousPorts {
  readonly audit: { record(event: AuditEvent): unknown; load(scopeId: string, eventId: string): AuditRecord | null | Promise<AuditRecord | null> };
  readonly now: () => number;
}
export type NervousContext = Readonly<{ owner: Readonly<{ issuer: string; subject: string }>; policyRevision: string }>;
export type NervousOutcome = Readonly<{ caseId: string; ruleId: string; action: NervousProposal['action']; disposition: NervousDisposition; replay: boolean; executed: boolean }>;
const PRESENT = new Set(['missing', 'created', 'running', 'paused', 'exited']);
/** Insertion-ordered bounded memory: the oldest key leaves first. */
function bounded<K, V>(map: Map<K, V>, key: K, value: V, max: number) { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value as K); }

/**
 * S6 Nervous K-B + S6R-2 (owner 2026-10-23, anchor s6r-kayip-calisan-2026-10-23; law-audit fold 4): deterministic rules from the versioned
 * registry over existing signals (no model call). Each case yields ONE typed proposal from the K-B standing list, sealed as `recovery-detection`
 * by the Nervous principal before anything else; the broker step executes it only when live, under the owner's standing approval through an
 * injected executor (existing applications, S6R-3). Nervous writes no other state and never opens an Attempt. Memory (absence series, outage
 * start, sealed cases, feed cursors) is per process and bounded; a restart only delays a fire, and a sealed case is a replay, never a second row.
 */
export class NervousApplication {
  readonly rules: NervousRules;
  private readonly absences = new Map<string, NervousAbsence>();
  private readonly outages = new Map<string, number>();
  private readonly sealed = new Map<string, true>();
  private readonly cursors = new Map<string, number>();
  constructor(private readonly ports: NervousPorts, rules: unknown, private readonly options: Readonly<{ live: boolean; approval: unknown; executors: NervousExecutors }>) {
    this.rules = loadNervousRules(rules);
  }
  /** One reconciliation page of one scope. The whole batch is validated first: a signal of another scope refuses it and seals nothing. */
  async observeAttempts(scopeId: string, input: readonly NervousAttemptSignal[], context: NervousContext): Promise<readonly NervousOutcome[]> {
    const scope = identitySchema.safeParse(scopeId), signals = input.map(value => nervousAttemptSignalSchema.safeParse(value));
    if (!scope.success || signals.some(parsed => !parsed.success || parsed.data.identity.scopeId !== scopeId)) throw new NervousError('NERVOUS_SIGNAL_INVALID');
    const now = this.ports.now(), proposals: NervousProposal[] = [], seen = new Set<string>();
    for (const parsed of signals) {
      const signal = parsed.data!, key = JSON.stringify(signal.identity);
      if (seen.has(key)) continue; seen.add(key);
      const absence = advanceNervousAbsence(this.absences.get(key), signal, now);
      if (absence) bounded(this.absences, key, absence, this.rules.tracking.maxAttempts); else this.absences.delete(key);
      const proposal = detectNervousAttempt(this.rules, signal, absence, now);
      if (proposal) proposals.push(proposal);
    }
    const parsed = signals.map(value => value.data!);
    if (parsed.some(signal => PRESENT.has(signal.activity))) this.outages.delete(scopeId);
    else if (parsed.some(signal => signal.activity === 'control-failed')) {
      if (!this.outages.has(scopeId)) bounded(this.outages, scopeId, now, this.rules.tracking.maxAttempts);
      proposals.push(...detectNervousOutage(this.rules, scopeId, this.outages.get(scopeId)!, now));
    }
    return this.apply(proposals, context);
  }
  /** The last audit sequence of `kind` this process read in `scopeId` (0: from the start). */
  feedCursor(scopeId: string, kind: NervousFeedKind): number { return this.cursors.get(`${scopeId}\0${kind}`) ?? 0; }
  /** One verified audit page of one kind in one scope, strictly after this process's cursor; a foreign, other-kind or stale record refuses the page. */
  async observeFeed(scopeId: string, kind: NervousFeedKind, records: readonly Readonly<{ sequence: number; event: AuditEvent }>[], context: NervousContext): Promise<readonly NervousOutcome[]> {
    let last = this.feedCursor(scopeId, kind);
    const page = records.map(record => {
      const event = auditEventSchema.safeParse(record.event);
      if (!event.success || event.data.scopeId !== scopeId || event.data.subject.kind !== kind || !Number.isSafeInteger(record.sequence) || record.sequence <= last) throw new NervousError('NERVOUS_SIGNAL_INVALID');
      last = record.sequence; return { sequence: record.sequence, event: event.data };
    });
    const proposals = page.map(record => detectNervousFeed(this.rules, record)).filter((value): value is NervousProposal => value !== null);
    const outcomes = await this.apply(proposals, context);
    bounded(this.cursors, `${scopeId}\0${kind}`, last, this.rules.tracking.maxAttempts);
    return outcomes;
  }
  private async apply(proposals: readonly NervousProposal[], context: NervousContext): Promise<readonly NervousOutcome[]> {
    const outcomes: NervousOutcome[] = [];
    for (const proposal of proposals) { const outcome = await this.broker(proposal, context); if (outcome) outcomes.push(outcome); }
    return Object.freeze(outcomes);
  }
  /**
   * The broker step for one proposal: anything but a valid proposal naming a standing-list action is refused (nothing sealed or run). A case
   * this process sealed is skipped; one already in the ledger is a replay (never executed again here: re-application from a sealed record is
   * S6R-3's, with idempotent executors). Otherwise the detection is sealed first, and only an `execute` disposition then runs its executor.
   */
  async broker(input: unknown, context: NervousContext): Promise<NervousOutcome | null> {
    const parsed = nervousProposalSchema.safeParse(input);
    if (!parsed.success || !(RECOVERY_ACTIONS as readonly string[]).includes(parsed.data.action)) throw new NervousError('NERVOUS_ACTION_REFUSED');
    const proposal = parsed.data, eventId = `recovery-detection:${proposal.caseId}`, key = `${proposal.scopeId}\0${eventId}`;
    if (this.sealed.has(key)) return null;
    const outcome = (disposition: NervousDisposition, replay: boolean, executed: boolean): NervousOutcome =>
      Object.freeze({ caseId: proposal.caseId, ruleId: proposal.rule.id, action: proposal.action, disposition, replay, executed });
    const existing = await this.ports.audit.load(proposal.scopeId, eventId);
    if (existing?.event.subject.kind === 'recovery-detection') {
      bounded(this.sealed, key, true, this.rules.tracking.maxAttempts); return outcome(existing.event.subject.disposition, true, false);
    }
    const disposition = nervousDisposition(proposal, this.options.live === true, this.options.approval, this.options.executors);
    const { target } = proposal, attempt = target.kind === 'attempt' ? { runId: target.identity.runId, taskId: target.identity.taskId, attemptId: target.identity.attemptId,
      generation: target.identity.generation } : target.kind === 'task' ? { runId: target.runId, taskId: target.taskId, attemptId: target.attemptId, generation: null } : null;
    await this.ports.audit.record(auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId: proposal.scopeId,
      principal: nervousPrincipalRef(context.owner), policyRevision: context.policyRevision, atMs: this.ports.now(),
      subject: { kind: 'recovery-detection', caseId: proposal.caseId, rule: proposal.rule, registryRevision: proposal.registryRevision, action: proposal.action,
        disposition, target: attempt, evidence: proposal.evidence, evidenceDigest: proposal.evidenceDigest } }));
    bounded(this.sealed, key, true, this.rules.tracking.maxAttempts);
    if (disposition !== 'execute') return outcome(disposition, false, false);
    await this.options.executors[proposal.action]!(proposal);
    return outcome(disposition, false, true);
  }
}
