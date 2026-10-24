import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_DECISION_ACTIONS, RECOVERY_RUN_MODES, RECOVERY_CAUSE_CLASSES, RecoveryError, encodeCommandProjection, identitySchema, isFinalRecoveryCase, isRecoveryPrincipal,
  loadRecoveryDecisionRegistry, readRecoveryDecisionAnswer, recoveryDecisionAnswerShape, recoveryDecisionTemplate, subscriptionDelegationRefusal, type AuditEvent, type AuditRecord,
  type RecoveryCase, type RecoveryDecisionRegistry, type RecoveryEscalationCode, type RunSnapshot } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { AUDIT_PAGE_MAX } from '#engine/core/audit/index.js';
import { recoveryContinuationApprovalSchema } from './approval.js';
import { recoveryDecisionCommandId, type RecoveryApplication, type RecoveryPrepared } from './application.js';
import type { RecoveryStore } from './port.js';

/** One `recovery-decision` role row in a scope (S2 registry, composition-resolved): whether an invocation profile serves it here, its channel's
 * billing axis (catalog data) and the delegated-use consent its profile carries (S3-3 writes it; null: none). */
export type RecoveryModelRow = Readonly<{ channelId: string; modelId: string; invocable: boolean; billing: 'subscription' | 'metered' | 'local' | null; consent: unknown }>;
export type RecoveryModelRequest = Readonly<{ scopeId: string; commandId: string; row: RecoveryModelRow; messages: readonly Readonly<{ role: 'system' | 'user'; content: string }>[];
  maxCompletionTokens: number }>;
/** The one call's result; `invocationId` null: nothing was claimed. A thrown error is a failed call too (its `code`). */
export type RecoveryModelResult = Readonly<{ status: 'responded'; text: string; invocationId: string | null }> | Readonly<{ status: 'failed'; code: string; invocationId: string | null }>;
/** The existing model-invocation path under the recovery principal (composition): the role's rows, and one call (retries 0, the command id replays). */
export interface RecoveryModelPorts {
  rows(scopeId: string): Promise<readonly RecoveryModelRow[]>;
  invoke(request: RecoveryModelRequest): Promise<RecoveryModelResult>;
}
export interface RecoveryDecisionPorts {
  readonly recovery: Pick<RecoveryApplication, 'prepare' | 'assess' | 'continueLostTask' | 'escalate'>;
  readonly store: Pick<RecoveryStore, 'loadCase' | 'loadRun'>;
  /** The audit writer of the decision seal (the recovery principal's only other record), its reader, and (S6R-6) the bounded recent window of one
   * kind the circuit breaker counts. */
  readonly seals: { load(scopeId: string, eventId: string): AuditRecord | null | Promise<AuditRecord | null>; record(event: unknown): unknown;
    listRecentKind(scopeId: string, kind: 'recovery-decision', sinceAtMs: number, limit: number): readonly AuditRecord[] | Promise<readonly AuditRecord[]> };
  readonly models: RecoveryModelPorts;
  /** The owner's standing grant of a continuation in a scope, read fresh (S6R-4 `recoveryContinuationApproval`). */
  readonly approval: (scopeId: string) => Promise<unknown>;
  /** The person the recovery principal acts for (the subscription consent must be theirs). */
  readonly owner: Readonly<{ issuer: string; subject: string }>;
  readonly policyRevision: string;
  readonly registry: unknown;
  readonly now: () => number;
  /** S6R-6: the scopes whose sealed decisions the installation circuit breaker counts (composition: every scope the service decides; absent: the
   * case's own scope). The count is read from the ledger per check, so it survives a restart. */
  readonly breakerScopes?: () => readonly string[];
}
type Sealed = Extract<AuditEvent['subject'], { kind: 'recovery-decision' }>;
type Mode = 'shadow' | 'live';
export type RecoveryDecisionOutcome = Readonly<{ kind: 'skipped'; reason: 'off' | 'not-ready' }>
  | Readonly<{ kind: 'shadow'; action: Sealed['action']; code: string | null; replay: boolean }>
  | Readonly<{ kind: 'continued'; case: RecoveryCase; run: RunSnapshot | null; replay: boolean }>
  | Readonly<{ kind: 'escalated'; case: RecoveryCase; replay: boolean }>;
const decideSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, caseId: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(RECOVERY_RUN_MODES) }).strict();
const OFFERED = Object.freeze([...RECOVERY_DECISION_ACTIONS]);
const failureCode = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' && identitySchema.safeParse(code).success ? code : 'RECOVERY_MODEL_CALL_FAILED'; };

/**
 * S6R-5 (S6R-DESIGN §6, §7 step 5–6, §8, §9, §11 phase 1; owner Q-R1/Q-R2/Q-R5, Q-H3): the recovery decision of one sealed lost-worker case. The
 * deterministic gate runs first (`RecoveryApplication.prepare`): a refusal, (live only) no owner standing grant for a continuation, no eligible
 * `recovery-decision` role row, no delegated-use consent for a subscription row, or an open circuit breaker each seal `escalate-human` without a
 * model call (alpha.56: shadow — including every would-stop case — asks the model without the grant, inside the breaker). Otherwise the role model reads the sealed evidence projection once (retries 0; its command id is the decision id, so a claimed call
 * replays and is never sent again) and its answer is read strictly; any failure is a sealed escalation with the typed reason, never a re-ask. The
 * decision is sealed (`recovery-decision`) before its apply; a sealed decision is applied on replay without a second call (N17). `shadow` — the
 * config's or the Run's frozen mode, the stricter wins — seals what would happen and writes nothing else: no case, no hold, no continuation.
 */
export class RecoveryDecisionApplication {
  private readonly registry: RecoveryDecisionRegistry;
  constructor(private readonly ports: RecoveryDecisionPorts, private readonly verifier: PrincipalVerifier) {
    this.registry = loadRecoveryDecisionRegistry(ports.registry);
  }
  async decide(input: unknown, credential?: unknown): Promise<RecoveryDecisionOutcome> {
    const command = decideSchema.parse(input), principal = await authenticate(this.verifier, credential, command.scopeId);
    if (!isRecoveryPrincipal(principal) || principal.assurance !== 'workload-verified') throw new RecoveryError('RECOVERY_PRINCIPAL_REQUIRED');
    const ref = { schemaVersion: 1 as const, scopeId: command.scopeId, caseId: command.caseId }, { recovery, store } = this.ports;
    const existing = command.mode === 'live' ? await store.loadCase(command.scopeId, command.caseId) : null;
    if (existing) return this.resume(existing, credential);
    let prepared: RecoveryPrepared;
    try { prepared = await recovery.prepare(ref, credential); } catch (error) {
      if (error instanceof RecoveryError && error.code === 'RECOVERY_OFF') return Object.freeze({ kind: 'skipped' as const, reason: 'off' as const });
      if (error instanceof RecoveryError && error.code === 'RECOVERY_NOT_READY') return Object.freeze({ kind: 'skipped' as const, reason: 'not-ready' as const });
      throw error;
    }
    // alpha.56 G1: a would-stop case is shadow input whatever the command or the Run says.
    const mode: Mode = command.mode === 'live' && prepared.run.execution.recovery?.mode === 'live' && !prepared.draft.basis ? 'live' : 'shadow';
    if (mode === 'shadow') {
      const sealed = await this.loadSeal(command.scopeId, command.caseId, 'shadow');
      if (sealed) return Object.freeze({ kind: 'shadow' as const, action: sealed.action, code: sealed.code, replay: true });
      const subject = await this.seal(prepared.draft, 'shadow', prepared.refused ? this.escalation(prepared.refused) : await this.choose(prepared.draft, prepared.run, 'shadow'));
      return Object.freeze({ kind: 'shadow' as const, action: subject.action, code: subject.code, replay: false });
    }
    // A gate or bound refusal is sealed first, then `assess` closes the case and holds the Run for a person.
    if (prepared.refused) {
      await this.seal(prepared.draft, 'live', this.escalation(prepared.refused));
      return this.final(await recovery.assess(ref, credential), false);
    }
    const current = await recovery.assess(ref, credential);
    return current.state === 'gated' ? this.resume(current, credential) : this.final(current, false);
  }
  /** A live case already in the ledger: a final one replays (an escalation re-issues its idempotent hold); a gated one applies its sealed decision, or decides now. */
  private async resume(current: RecoveryCase, credential: unknown): Promise<RecoveryDecisionOutcome> {
    const ref = { schemaVersion: 1 as const, scopeId: current.identity.scopeId, caseId: current.caseId };
    if (isFinalRecoveryCase(current)) return this.final(await this.ports.recovery.assess(ref, credential), true);
    const sealed = await this.loadSeal(ref.scopeId, current.caseId, 'live');
    let subject = sealed;
    if (!subject) {
      // S6R-6: a case already decided by its model in shadow (same evidence) is not asked again after the switch to live: the live seal adopts the
      // shadow decision (`basis: 'shadow'`, its call's model block). A shadow seal without a model (a deterministic escalation) is decided afresh.
      // alpha.56: a would-stop shadow seal is never adopted (it decided a counterfactual); a shadow seal carries no grant, so an adopted continuation
      // re-derives it now and without it is sealed `continuation-not-approved` (lead decision, R-DESIGN §9).
      const shadow = await this.loadSeal(ref.scopeId, current.caseId, 'shadow');
      if (shadow && shadow.model !== null && shadow.basis !== 'would-stop' && shadow.evidenceDigest === current.evidenceDigest) {
        const { model, action, causeClass, note, code, failure } = shadow, standingRef = action === 'continue-new-attempt' ? await this.standingRef(ref.scopeId) : null;
        subject = await this.seal(current, 'live', action === 'continue-new-attempt' && standingRef === null ? { ...this.escalation('continuation-not-approved'), model, basis: 'shadow' }
          : { model, action, causeClass, note, code, failure, standingRef, basis: 'shadow' });
      } else {
        const run = await this.ports.store.loadRun(ref.scopeId, current.identity.runId);
        if (!run) throw new RecoveryError('RECOVERY_CORRUPT');
        subject = await this.seal(current, 'live', await this.choose(current, run, 'live'));
      }
    }
    const echo = { ...ref, evidenceDigest: current.evidenceDigest };
    // A sealed escalation of other evidence (a gate refusal sealed, then a crash before `assess`, then the evidence changed) still hands the case to a
    // person — never a model call for a case already sealed to a human. A sealed continuation of other evidence is never applied.
    if (subject.evidenceDigest !== current.evidenceDigest) {
      if (subject.action !== 'escalate-human' || subject.code === null) throw new RecoveryError('RECOVERY_STALE');
      return Object.freeze({ kind: 'escalated' as const, case: await this.ports.recovery.escalate({ ...echo, code: subject.code }, credential), replay: true });
    }
    if (subject.action === 'continue-new-attempt') {
      const outcome = await this.ports.recovery.continueLostTask({ ...echo, causeClass: subject.causeClass, note: subject.note }, credential);
      return outcome.kind === 'continued' ? Object.freeze({ kind: 'continued' as const, case: outcome.case, run: outcome.run, replay: sealed !== null })
        : Object.freeze({ kind: 'escalated' as const, case: outcome.case, replay: sealed !== null });
    }
    return Object.freeze({ kind: 'escalated' as const, case: await this.ports.recovery.escalate({ ...echo, code: subject.code }, credential), replay: sealed !== null });
  }
  private async final(current: RecoveryCase, replay: boolean): Promise<RecoveryDecisionOutcome> {
    if (current.state === 'applied') return Object.freeze({ kind: 'continued' as const, case: current, run: await this.ports.store.loadRun(current.identity.scopeId, current.identity.runId), replay });
    return Object.freeze({ kind: 'escalated' as const, case: current, replay });
  }
  private escalation(code: RecoveryEscalationCode, failure: string | null = null) {
    return { model: null, action: 'escalate-human' as const, causeClass: null, note: null, code, failure, standingRef: null };
  }
  /** The decision for a case whose gate passed: deterministic escalations first, then the one call and its strict answer. */
  private async choose(current: RecoveryCase, run: RunSnapshot, mode: Mode): Promise<Omit<Sealed, 'kind' | 'caseId' | 'mode' | 'evidenceDigest' | 'target' | 'gate' | 'terminationReceiptId'>> {
    const { scopeId } = current.identity, registry = this.registry, now = this.ports.now();
    // alpha.56 G1 (owner Q-A6): shadow is the owner's permission to spend inside the breaker — the model is asked without the continuation grant,
    // and the shadow seal names no grant. Live still needs it.
    const standingRef = mode === 'live' ? await this.standingRef(scopeId) : null;
    if (mode === 'live' && standingRef === null) return this.escalation('continuation-not-approved');
    if (await this.breakerOpen(scopeId, now)) return this.escalation('breaker-open');
    const rows = (await this.ports.models.rows(scopeId)).filter(row => row.invocable);
    if (!rows.length) return this.escalation('no-eligible-model');
    const row = rows.find(candidate => subscriptionDelegationRefusal({ billing: candidate.billing, principalClass: 'system', owner: this.ports.owner, consent: candidate.consent }) === null);
    if (!row) return this.escalation('consent-required', 'HEADLESS_DELEGATION_REFUSED');
    const template = recoveryDecisionTemplate(registry), messages = [{ role: 'system' as const, content: template.text },
      { role: 'user' as const, content: JSON.stringify(this.request(current, run)) }];
    let result: RecoveryModelResult;
    try {
      result = await this.ports.models.invoke({ scopeId, commandId: recoveryDecisionCommandId(current.caseId, current.evidenceDigest, mode), row, messages,
        maxCompletionTokens: registry.call.maxCompletionTokens });
    } catch (error) { result = { status: 'failed', code: failureCode(error), invocationId: null }; }
    const model = { channelId: row.channelId, modelId: row.modelId, template: { id: template.id, version: template.version }, registryRevision: registry.revision,
      inputDigest: sha256(encodeCommandProjection('recovery-decision-input:1', messages)),
      outputDigest: result.status === 'responded' ? sha256(encodeCommandProjection('recovery-decision-output:1', result.text)) : null, invocationId: result.invocationId };
    if (result.status === 'failed') return { ...this.escalation('model-failed', failureCode(result)), model };
    const answer = readRecoveryDecisionAnswer(result.text, { caseId: current.caseId, evidenceDigest: current.evidenceDigest, offered: OFFERED }, registry);
    if (!answer.ok) return { ...this.escalation('answer-invalid', answer.failure), model };
    if (answer.action === 'escalate-human') return { ...this.escalation('human-chosen'), causeClass: answer.causeClass, model };
    return { model, action: 'continue-new-attempt', causeClass: answer.causeClass, note: answer.note, code: null, failure: null, standingRef };
  }
  /** The owner's standing grant of a continuation in `scopeId`, read fresh (null: none, or unreadable). */
  private async standingRef(scopeId: string): Promise<string | null> {
    const approval = recoveryContinuationApprovalSchema.safeParse(await this.ports.approval(scopeId).catch(() => null));
    return approval.success && approval.data.scopeIds.includes(scopeId) ? approval.data.decisionRef : null;
  }
  /**
   * S6R-6 installation circuit breaker, persistent: the model calls of recovery decisions (shadow — would-stop included — and live seals with a
   * model block; a live seal adopting a shadow decision is the same call) sealed in the registry window across the breaker scopes. Open at the bound, when a window holds
   * `scanLimit` seals without reaching it, or when the ledger cannot be read (fail closed: no call). A crash between the call and its seal is the
   * one call not yet counted; its replay finds the claimed invocation (command id) and never sends it again.
   */
  private async breakerOpen(scopeId: string, now: number): Promise<boolean> {
    const { maxCasesPerWindow, windowMs, scanLimit } = this.registry.breaker, since = Math.max(0, now - windowMs + 1), limit = Math.min(scanLimit, AUDIT_PAGE_MAX);
    if (maxCasesPerWindow === 0) return true;
    try {
      let calls = 0;
      for (const id of new Set(this.ports.breakerScopes?.() ?? [scopeId])) {
        const page = await this.ports.seals.listRecentKind(id, 'recovery-decision', since, limit);
        calls += page.filter(record => record.event.subject.kind === 'recovery-decision' && record.event.subject.model !== null && record.event.subject.basis !== 'shadow').length;
        if (calls >= maxCasesPerWindow || page.length >= limit) return true;
      }
      return false;
    } catch { return true; }
  }
  /** The evidence projection the model reads (S6R-DESIGN §5, §6): typed states, counts and codes of the sealed case only — no policy, principal, path or log. */
  private request(current: RecoveryCase, run: RunSnapshot) {
    const previous = (run.previousBindings ?? []).filter(row => row.identity.taskId === current.identity.taskId), registry = this.registry;
    return { schemaVersion: 1, caseId: current.caseId, evidenceDigest: current.evidenceDigest, offered: OFFERED, causeClasses: RECOVERY_CAUSE_CLASSES,
      noteCodes: registry.noteCodes.map(row => row.code), answerSchema: recoveryDecisionAnswerShape, rationaleMaxChars: registry.answer.rationaleMaxChars,
      evidence: { rule: { id: current.detection.ruleId, version: current.detection.ruleVersion }, activity: current.detection.activity, launcherPhase: current.detection.launcherPhase,
        termination: { kind: current.termination.kind, exitCode: current.termination.exitCode },
        gate: { result: current.gate.result, settled: current.gate.settled, intents: current.gate.intents.length, settledFacts: current.gate.facts.length },
        attempts: { used: previous.length + 1, ceiling: run.execution.recovery?.maxAttemptsPerTask ?? null,
          lost: previous.filter(row => row.observedKind === 'lost').length, stalled: previous.filter(row => row.observedKind === 'stalled').length } } };
  }
  private eventId = (caseId: string, mode: Mode) => mode === 'live' ? `recovery-decision:${caseId}` : `recovery-decision:shadow:${caseId}`;
  private async loadSeal(scopeId: string, caseId: string, mode: Mode): Promise<Sealed | null> {
    const subject = (await this.ports.seals.load(scopeId, this.eventId(caseId, mode)))?.event.subject;
    if (!subject) return null;
    if (subject.kind !== 'recovery-decision' || subject.caseId !== caseId || subject.mode !== mode) throw new RecoveryError('RECOVERY_CORRUPT');
    return subject;
  }
  /** Seals one decision (an existing seal of the case is kept: a replay never writes a second one). */
  private async seal(current: RecoveryCase, mode: Mode, decision: Omit<Sealed, 'kind' | 'caseId' | 'mode' | 'evidenceDigest' | 'target' | 'gate' | 'terminationReceiptId'>): Promise<Sealed> {
    const { scopeId, runId, taskId, attemptId, generation } = current.identity, held = await this.loadSeal(scopeId, current.caseId, mode);
    if (held) return held;
    const subject: Sealed = { kind: 'recovery-decision', caseId: current.caseId, mode, evidenceDigest: current.evidenceDigest, target: { runId, taskId, attemptId, generation },
      gate: { result: current.gate.result, settled: current.gate.settled, intents: current.gate.intents.length }, terminationReceiptId: current.termination.receiptId, ...decision,
      ...(current.basis ? { basis: current.basis } : {}) };
    const principal = await authenticate(this.verifier, undefined, scopeId);
    await this.ports.seals.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: this.eventId(current.caseId, mode), scopeId,
      principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.ports.policyRevision, atMs: this.ports.now(), subject } satisfies AuditEvent);
    return subject;
  }
}
