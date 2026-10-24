import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_ACTIONS, auditEventSchema, identitySchema, nervousPrincipalRef, type AuditEvent, type AuditRecord } from '#domain/index.js';
import { NervousError, loadNervousRules, promoteNervousRule, type NervousRules } from './rules.js';
import { advanceNervousAbsence, detectNervousAttempt, detectNervousFeed, detectNervousOutage, nervousAttemptSignalSchema, nervousProposalSchema,
  type NervousAbsence, type NervousAttemptSignal, type NervousFeedKind, type NervousProposal } from './detect.js';
import { nervousDisposition, nervousStandingApprovalSchema, type NervousDisposition, type NervousExecutors } from './broker.js';

/** The one audit writer (seal before any effect; an existing case is a replay) and the trusted wall clock. Nervous holds no other write port. */
export interface NervousPorts {
  readonly audit: { record(event: AuditEvent): unknown; load(scopeId: string, eventId: string): AuditRecord | null | Promise<AuditRecord | null> };
  readonly now: () => number;
}
/** `approval` (S6R-3): the owner's standing approval for one proposal, read from this scope's loaded policy (absent: the constructor's record).
 * `promoted` (alpha.56 G2): whether a person promoted exactly this rule id and version in this scope, read fresh per page (absent: none). */
export type NervousContext = Readonly<{ owner: Readonly<{ issuer: string; subject: string }>; policyRevision: string; approval?: (proposal: NervousProposal) => unknown;
  promoted?: (ruleId: string, version: number) => boolean }>;
export type NervousOutcome = Readonly<{ caseId: string; ruleId: string; action: NervousProposal['action']; disposition: NervousDisposition; replay: boolean; executed: boolean }>;
const PRESENT = new Set(['missing', 'created', 'running', 'paused', 'exited']);
/** Insertion-ordered bounded memory: the oldest key leaves first. */
function bounded<K, V>(map: Map<K, V>, key: K, value: V, max: number) { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value as K); }

/**
 * S6 Nervous K-B + S6R-2 (owner 2026-10-23, anchor s6r-kayip-calisan-2026-10-23; law-audit fold 4): deterministic rules from the versioned
 * registry over existing signals (no model call). Each case yields ONE typed proposal from the K-B standing list, sealed as `recovery-detection`
 * by the Nervous principal before anything else; the broker step executes it only when live, under the owner's standing approval through an
 * injected executor (existing applications, S6R-3 `nervousExecutors`). Nervous writes no other state and never opens an Attempt. Memory (absence series, outage
 * start, sealed cases, feed cursors) is per process and bounded; a restart only delays a fire, and a sealed case is a replay, never a second row.
 */
export class NervousApplication {
  readonly rules: NervousRules;
  private readonly absences = new Map<string, NervousAbsence>();
  private readonly outages = new Map<string, number>();
  private readonly sealed = new Map<string, true>();
  private readonly applied = new Map<string, number>();
  private readonly cursors = new Map<string, number>();
  constructor(private readonly ports: NervousPorts, rules: unknown, private readonly options: Readonly<{ live: boolean; approval: unknown; executors: NervousExecutors }>) {
    this.rules = loadNervousRules(rules);
  }
  /** One reconciliation page of one scope. The whole batch is validated first: a signal of another scope refuses it and seals nothing. */
  async observeAttempts(scopeId: string, input: readonly NervousAttemptSignal[], context: NervousContext): Promise<readonly NervousOutcome[]> {
    const scope = identitySchema.safeParse(scopeId), signals = input.map(value => nervousAttemptSignalSchema.safeParse(value));
    if (!scope.success || signals.some(parsed => !parsed.success || parsed.data.identity.scopeId !== scopeId)) throw new NervousError('NERVOUS_SIGNAL_INVALID');
    const now = this.ports.now(), proposals: NervousProposal[] = [], seen = new Set<string>(), replayOnly = new Set<string>();
    for (const parsed of signals) {
      const signal = parsed.data!, key = JSON.stringify(signal.identity);
      if (seen.has(key)) continue; seen.add(key);
      const absence = advanceNervousAbsence(this.absences.get(key), signal, now);
      if (absence) bounded(this.absences, key, absence, this.rules.tracking.maxAttempts); else this.absences.delete(key);
      const proposal = detectNervousAttempt(this.rules, signal, absence, now);
      if (proposal) proposals.push(proposal);
      if (proposal && signal.fenced) replayOnly.add(proposal.caseId);
    }
    const parsed = signals.map(value => value.data!);
    if (parsed.some(signal => PRESENT.has(signal.activity))) this.outages.delete(scopeId);
    else if (parsed.some(signal => signal.activity === 'control-failed')) {
      if (!this.outages.has(scopeId)) bounded(this.outages, scopeId, now, this.rules.tracking.maxAttempts);
      proposals.push(...detectNervousOutage(this.rules, scopeId, this.outages.get(scopeId)!, now));
    }
    return this.apply(proposals, context, replayOnly);
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
  private async apply(proposals: readonly NervousProposal[], context: NervousContext, replayOnly: ReadonlySet<string> = new Set()): Promise<readonly NervousOutcome[]> {
    // One case's failed step never blocks the other cases of the page: each is tried, the first failure is reported after all of them.
    const outcomes: NervousOutcome[] = [], failures: unknown[] = [];
    for (const proposal of proposals) {
      try { const outcome = await this.broker(proposal, context, replayOnly.has(proposal.caseId)); if (outcome) outcomes.push(outcome); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
    return Object.freeze(outcomes);
  }
  /**
   * The broker step for one proposal: anything but a valid proposal naming a standing-list action is refused (nothing sealed or run). A case
   * this process completed is skipped. One already in the ledger is a replay: only a sealed `execute` that would still execute now (live, the
   * grant still there) is re-applied (s6 Q6 / N17: a crash between seal and effect), through idempotent executors that re-derive each step from
   * the ledger; a sealed shadow or proposal case never executes later. Otherwise the detection is sealed first, then an `execute` runs. A case is
   * marked done once its executor returned anything but `pending` (stop issued, proof pending): a failed or pending step is re-applied from its
   * sealed record on a later page (a fenced dispatch is `replayOnly`: it re-applies its sealed case, never opens a new one), at most
   * `tracking.maxApplications` times per process; the last application hands a still-pending case to a person.
   */
  async broker(input: unknown, context: NervousContext, replayOnly = false): Promise<NervousOutcome | null> {
    const parsed = nervousProposalSchema.safeParse(input);
    if (!parsed.success || !(RECOVERY_ACTIONS as readonly string[]).includes(parsed.data.action)) throw new NervousError('NERVOUS_ACTION_REFUSED');
    // alpha.56 G2: the effective status is fixed before the seal, so the sealed `rule.status` is the one the broker applied (a seed version bump demotes).
    const proposal = promoteNervousRule(parsed.data, context.promoted), eventId = `recovery-detection:${proposal.caseId}`, key = `${proposal.scopeId}\0${eventId}`;
    if (this.sealed.has(key)) return null;
    const outcome = (disposition: NervousDisposition, replay: boolean, executed: boolean): NervousOutcome =>
      Object.freeze({ caseId: proposal.caseId, ruleId: proposal.rule.id, action: proposal.action, disposition, replay, executed });
    const approval = context.approval ? context.approval(proposal) : this.options.approval;
    const disposition = nervousDisposition(proposal, this.options.live === true, approval, this.options.executors);
    const done = () => bounded(this.sealed, key, true, this.rules.tracking.maxAttempts);
    const run = async () => {
      const count = (this.applied.get(key) ?? 0) + 1; bounded(this.applied, key, count, this.rules.tracking.maxAttempts);
      if (await this.options.executors[proposal.action]!(proposal, { last: count >= this.rules.tracking.maxApplications }) !== 'pending') done();
    };
    const existing = await this.ports.audit.load(proposal.scopeId, eventId);
    if (existing?.event.subject.kind === 'recovery-detection') {
      const sealed = existing.event.subject;
      if (sealed.disposition !== 'execute' || disposition !== 'execute' || sealed.action !== proposal.action) { done(); return outcome(sealed.disposition, true, false); }
      await run(); return outcome('execute', true, true);
    }
    if (replayOnly) { done(); return null; }
    const { target } = proposal, attempt = target.kind === 'attempt' ? { runId: target.identity.runId, taskId: target.identity.taskId, attemptId: target.identity.attemptId,
      generation: target.identity.generation } : target.kind === 'task' ? { runId: target.runId, taskId: target.taskId, attemptId: target.attemptId, generation: null } : null;
    await this.ports.audit.record(auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId: proposal.scopeId,
      principal: nervousPrincipalRef(context.owner), policyRevision: context.policyRevision, atMs: this.ports.now(),
      subject: { kind: 'recovery-detection', caseId: proposal.caseId, rule: proposal.rule, registryRevision: proposal.registryRevision, action: proposal.action,
        disposition, target: attempt, evidence: proposal.evidence, evidenceDigest: proposal.evidenceDigest,
        ...(disposition === 'execute' ? { standingRef: nervousStandingApprovalSchema.parse(approval).decisionRef } : {}) } }));
    if (disposition !== 'execute') { done(); return outcome(disposition, false, false); }
    await run(); return outcome(disposition, false, true);
  }
}
