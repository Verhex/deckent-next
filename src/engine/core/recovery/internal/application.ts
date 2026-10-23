import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_CAUSE_CLASSES, RECOVERY_ESCALATION_CODES, RecoveryError, recoveryNoteCodeSchema, assessRecoveryEffectGate, closeRecoveryCase, encodeCommandProjection,
  encodeExecutionProfileDefinition, identitySchema, isRecoveryPrincipal, lostContinuationRefusal, recoveryCaseSchema, recoveryEscalationCode, recoveryHoldNote,
  type AuditEvent, type AuditRecord, type RecoveryCase, type RecoveryEscalationCode, type RunSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
import { recoveryContinuationApprovalSchema } from './approval.js';
import type { RecoveryStore } from './port.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const assessSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, caseId: digest }).strict();
const continueSchema = assessSchema.extend({ evidenceDigest: digest, causeClass: z.enum(RECOVERY_CAUSE_CLASSES), note: recoveryNoteCodeSchema.nullable().optional() }).strict();
const escalateSchema = assessSchema.extend({ evidenceDigest: digest, code: z.enum(RECOVERY_ESCALATION_CODES) }).strict();
/** The id of the one live decision of a case (its continuation's `recoveryDecisionId`) and of its one model call; a shadow decision has its own. */
export function recoveryDecisionCommandId(caseId: string, evidenceDigest: string, mode: 'shadow' | 'live'): string {
  return sha256(encodeCommandProjection(mode === 'live' ? 'recovery-decision:1' : 'recovery-decision-shadow:1', { caseId, evidenceDigest }));
}
/** What a case would be if sealed now (S6R-5 `prepare`): the gated draft, the gate or bound refusal it carries (null: it may be decided) and its Run. */
export type RecoveryPrepared = Readonly<{ draft: RecoveryCase; refused: RecoveryEscalationCode | null; run: RunSnapshot }>;
/** The one audit loader (Nervous detections), the recorder of the continuation event, the owner's standing grant read fresh per call, and the
 * s5b safety hold that hands a Run to a person. Nothing here reaches a model, a worker, a supervisor or an effect target. */
export interface RecoveryPorts {
  readonly store: RecoveryStore;
  readonly detections: { load(scopeId: string, eventId: string): AuditRecord | null | Promise<AuditRecord | null> };
  readonly recorder: (store: AuditStore) => { record(event: unknown): AuditRecord };
  readonly approval: (scopeId: string) => Promise<unknown>;
  readonly hold: (command: Readonly<{ schemaVersion: 1; scopeId: string; runId: string; commandId: string; holdReason: string }>) => Promise<unknown>;
  readonly policyRevision: string;
  readonly now: () => number;
  readonly timeoutMs: number;
}
export type RecoveryOutcome = Readonly<{ kind: 'continued'; case: RecoveryCase; run: RunSnapshot }> | Readonly<{ kind: 'escalated'; case: RecoveryCase }>;
const NOTHING_WRITTEN = new Set(['RECOVERY_OFF', 'RECOVERY_NOT_READY', 'RECOVERY_INVALID']);

/**
 * S6R-4 (S6R-DESIGN §7 steps 4–6, §8, §9; owner Q-R1/Q-R3/Q-R5): the recovery decision's application. `assess` opens the one case of a sealed Nervous
 * detection whose Attempt's slot was already released with a termination proof, computes the mandatory effect gate and the frozen bounds, and seals
 * it `gated` — or `escalated` with a hold for a person when the gate or a bound refuses (no model is ever asked then). `continueLostTask` is the one
 * application that opens a new Attempt for a lost worker: under the owner's standing grant, for a decision that echoes the sealed evidence, with the
 * gate and bounds re-derived in the writer's transaction. Only the recovery principal calls it; in S6R-4 only tests and shadow do (the chooser is S6R-5).
 */
export class RecoveryApplication {
  constructor(private readonly ports: RecoveryPorts, private readonly verifier: PrincipalVerifier) {}
  private async principal(scopeId: string, credential: unknown): Promise<VerifiedPrincipal> {
    const principal = await authenticate(this.verifier, credential, scopeId);
    if (!isRecoveryPrincipal(principal) || principal.assurance !== 'workload-verified') throw new RecoveryError('RECOVERY_PRINCIPAL_REQUIRED');
    return principal;
  }
  async assess(input: unknown, credential?: unknown): Promise<RecoveryCase> {
    const command = assessSchema.parse(input); await this.principal(command.scopeId, credential);
    const existing = await this.ports.store.loadCase(command.scopeId, command.caseId);
    // A sealed escalation re-issues its hold (idempotent by its case-derived command id): a crash between the seal and the hold never strands the Run.
    if (existing) { if (existing.decision?.action === 'escalate-human') await this.hold(existing, existing.decision.code); return existing; }
    const { draft, refused, run } = await this.draft(command);
    // S6R-5: only a Run frozen `live` writes a case; a shadow Run's decision is sealed elsewhere and changes nothing.
    if (run.execution.recovery?.mode !== 'live') throw new RecoveryError('RECOVERY_OFF');
    const saved = await this.ports.store.saveCase(null, draft);
    return refused ? this.close(saved, refused) : saved;
  }
  /** S6R-5: the read-only half of `assess` — the case a sealed detection would open now, its gate and bound refusal, and nothing written. */
  async prepare(input: unknown, credential?: unknown): Promise<RecoveryPrepared> {
    const command = assessSchema.parse(input); await this.principal(command.scopeId, credential);
    return this.draft(command);
  }
  private async draft(command: z.infer<typeof assessSchema>): Promise<RecoveryPrepared> {
    const eventId = `recovery-detection:${command.caseId}`, sealed = await this.ports.detections.load(command.scopeId, eventId), subject = sealed?.event.subject;
    if (!subject || subject.kind !== 'recovery-detection' || subject.caseId !== command.caseId || !subject.target) throw new RecoveryError('RECOVERY_NOT_FOUND');
    const target = subject.target, run = await this.ports.store.loadRun(command.scopeId, target.runId);
    const binding = run?.bindings.find(row => row.identity.attemptId === target.attemptId && row.identity.taskId === target.taskId
      && (target.generation === null || row.identity.generation === target.generation));
    if (!run || !binding) throw new RecoveryError('RECOVERY_NOT_READY');
    const identity = binding.identity, policy = run.execution.recovery;
    if (!policy) throw new RecoveryError('RECOVERY_OFF');
    const custody = run.progress.find(row => row.taskId === identity.taskId)?.workerCustody;
    const termination = custody?.state === 'released' && custody.proofReceiptId ? await this.ports.store.loadTermination(command.scopeId, custody.proofReceiptId) : null;
    if (!termination) throw new RecoveryError('RECOVERY_NOT_READY');
    const gate = assessRecoveryEffectGate(identity, await this.ports.store.listGateEffects(identity, policy.maxGateIntents + 1), policy);
    const refused = lostContinuationRefusal(run, identity, { signature: null, gate, priorSignatures: [] });
    if (refused && NOTHING_WRITTEN.has(refused)) throw new RecoveryError(refused);
    const detection = { eventId, ruleId: subject.rule.id, ruleVersion: subject.rule.version, registryRevision: subject.registryRevision, evidenceDigest: subject.evidenceDigest,
      activity: subject.evidence.activity, launcherPhase: subject.evidence.launcherPhase };
    const now = this.ports.now();
    const draft = recoveryCaseSchema.parse({ schemaVersion: 1, caseId: command.caseId, revision: 1, state: 'gated', identity, detection, termination, gate,
      evidenceDigest: sha256(encodeCommandProjection('recovery-case-evidence:1', { caseId: command.caseId, identity, detection, termination, gate })), openedAtMs: now, updatedAtMs: now });
    return Object.freeze({ draft, refused: refused ? recoveryEscalationCode(new RecoveryError(refused)) : null, run });
  }
  async continueLostTask(input: unknown, credential?: unknown): Promise<RecoveryOutcome> {
    const command = continueSchema.parse(input), principal = await this.principal(command.scopeId, credential);
    const current = await this.open(command.scopeId, command.caseId, command.evidenceDigest);
    if (current.state === 'applied') {
      if (current.decision?.action !== 'continue-new-attempt' || current.decision.causeClass !== command.causeClass
        || (current.decision.note ?? null) !== (command.note ?? null)) throw new RecoveryError('RECOVERY_CONFLICT');
      const run = await this.ports.store.loadRun(command.scopeId, current.identity.runId);
      if (!run) throw new RecoveryError('RECOVERY_CORRUPT');
      return Object.freeze({ kind: 'continued' as const, case: current, run });
    }
    if (current.state === 'escalated') throw new RecoveryError('RECOVERY_STALE');
    const approval = recoveryContinuationApprovalSchema.safeParse(await this.ports.approval(command.scopeId));
    // S6R-6: no owner standing grant (never given, or revoked after the decision) ends the case consistently: sealed escalated and the Run held for a
    // person (`continuation-not-approved`), never a case left gated for a later pass to retry.
    if (!approval.success || !approval.data.scopeIds.includes(command.scopeId)) return Object.freeze({ kind: 'escalated' as const, case: await this.close(current, 'continuation-not-approved') });
    const run = await this.ports.store.loadRun(command.scopeId, current.identity.runId);
    const profile = run?.execution.tasks.find(row => row.taskId === current.identity.taskId)?.profile;
    if (!run || !profile) throw new RecoveryError('RECOVERY_CORRUPT');
    const { detection, termination } = current;
    const signature = sha256(encodeCommandProjection('recovery-signature:1', { ruleId: detection.ruleId, ruleVersion: detection.ruleVersion, registryRevision: detection.registryRevision,
      causeClass: command.causeClass, termination: { kind: termination.kind, exitCode: termination.exitCode }, activity: detection.activity, launcherPhase: detection.launcherPhase,
      profile: sha256(encodeExecutionProfileDefinition(profile)) }));
    const decision = { action: 'continue-new-attempt' as const, decisionId: recoveryDecisionCommandId(current.caseId, current.evidenceDigest, 'live'),
      causeClass: command.causeClass, signature, standingRef: approval.data.decisionRef, ...(command.note ? { note: command.note } : {}) };
    const eventId = `recovery-continue:${current.caseId}`, inputDigest = sha256(encodeCommandProjection('recovery-continue:1', { caseId: current.caseId, decision }));
    try {
      const written = await this.ports.store.continueLostTask({ previous: current, decision, now: this.ports.now(), timeoutMs: this.ports.timeoutMs },
        (store, snapshot) => this.ports.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId: command.scopeId,
          principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.ports.policyRevision, atMs: this.ports.now(),
          subject: { kind: 'run-lifecycle', action: 'continue-lost-task', runId: current.identity.runId, taskId: current.identity.taskId, commandId: eventId,
            revision: snapshot.revision, evidence: null, deciderClass: 'system', decisionRuleId: decision.standingRef, inputDigest } } satisfies AuditEvent));
      return Object.freeze({ kind: 'continued' as const, ...written });
    } catch (error) {
      const code = recoveryEscalationCode(error);
      if (!code) throw error;
      const latest = await this.ports.store.loadCase(command.scopeId, current.caseId);
      if (!latest || latest.revision !== current.revision) throw new RecoveryError('RECOVERY_CONFLICT');
      return Object.freeze({ kind: 'escalated' as const, case: await this.close(latest, code) });
    }
  }
  /** The decision to hand the case to a person (S6R-5: the model's `escalate-human`, or a decision-path escalation): the case closes and the Run is held. */
  async escalate(input: unknown, credential?: unknown): Promise<RecoveryCase> {
    const command = escalateSchema.parse(input); await this.principal(command.scopeId, credential);
    const current = await this.open(command.scopeId, command.caseId, command.evidenceDigest);
    if (current.state === 'escalated' && current.decision?.action === 'escalate-human' && current.decision.code === command.code) return current;
    if (current.state === 'applied' || current.state === 'escalated') throw new RecoveryError('RECOVERY_CONFLICT');
    return this.close(current, command.code);
  }
  /** A case a decision may act on: it exists and the decision echoes its sealed evidence (any other digest, or a case already escalated, is stale). */
  private async open(scopeId: string, caseId: string, evidenceDigest: string) {
    const current = await this.ports.store.loadCase(scopeId, caseId);
    if (!current) throw new RecoveryError('RECOVERY_NOT_FOUND');
    if (current.evidenceDigest !== evidenceDigest) throw new RecoveryError('RECOVERY_STALE');
    return current;
  }
  /** Seals the escalation first, then (except for a Run already closing) the s5b safety hold with a case-derived command id: a replay holds once. */
  private async close(current: RecoveryCase, code: RecoveryEscalationCode): Promise<RecoveryCase> {
    const closed = await this.ports.store.saveCase(current, closeRecoveryCase(current, { action: 'escalate-human', code }, this.ports.now()));
    await this.hold(closed, code);
    return closed;
  }
  private async hold(closed: RecoveryCase, code: RecoveryEscalationCode) {
    if (code !== 'run-closed') await this.ports.hold({ schemaVersion: 1, scopeId: closed.identity.scopeId, runId: closed.identity.runId, commandId: `recovery-hold:${closed.caseId}`,
      holdReason: recoveryHoldNote(code, closed.caseId) });
  }
}
