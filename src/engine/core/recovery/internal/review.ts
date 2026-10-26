import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_DECISION_ACTIONS, RECOVERY_ROLLOUT, identitySchema, isAiPrincipal, type AuditEvent, type AuditRecord, type RecoveryRolloutRegistry,
  type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { recoveryModelDecided, type RecoveryRolloutPorts } from './rollout.js';

type Decision = Extract<AuditEvent['subject'], { kind: 'recovery-decision' }>;
/** One model-decided case waiting for a person's verdict. Blind (owner Q-A5): the model's choice is not part of it. `wouldStop`: decided as if the
 * stop had been applied (the counterfactual note). `attempts`: the task's Attempts so far (null: the Run could not be read). */
export type RecoveryReviewItem = Readonly<{ caseId: string; decisionEventId: string; evidenceDigest: string; rule: Readonly<{ id: string; version: number }> | null;
  activity: string | null; launcher: string | null; gate: Decision['gate']; runId: string; taskId: string; attempts: number | null; wouldStop: boolean; decidedAtMs: number }>;
/** What the person saw happen and what they would have done; the reveal returns the model's choice only after it is sealed. */
export type RecoveryVerdictOutcome = Readonly<{ status: 'recorded' | 'current'; caseId: string; detection: 'lost' | 'not-lost'; choice: Decision['action'] | null;
  model: Readonly<{ action: Decision['action']; causeClass: Decision['causeClass'] }>; agreed: boolean | null }>;
/** The review's reads (sealed records, Runs), its one write (the verdict seal, a person's), the person checks and the trusted clock. */
export interface RecoveryReviewPorts extends RecoveryRolloutPorts {
  load(scopeId: string, eventId: string): AuditRecord | null | Promise<AuditRecord | null>;
  record(event: unknown): unknown;
  /** The person may administer policy in the scope (`PolicyAdministrationInspection`); throws otherwise. */
  authorize(principal: VerifiedPrincipal, scopeId: string): Promise<void>;
  /** The controlling-terminal witness: a person at a real terminal, never a pipe, CI, MCP or a runtime peer. */
  interactive(): Promise<boolean>;
  readonly policyRevision: string;
  now(): number;
}
const scopeSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict();
const verdictSchema = scopeSchema.extend({ caseId: z.string().regex(/^[a-f0-9]{64}$/u), detection: z.enum(['lost', 'not-lost']), choice: z.enum(RECOVERY_DECISION_ACTIONS).nullable() })
  .strict().refine(value => (value.choice === null) === (value.detection === 'not-lost'));

/**
 * alpha.56 G4 (owner Q-A5): the person's blind review of shadow-decided recovery cases. `pending` lists model-decided cases without a verdict and
 * never their model choice; `answer` seals one `recovery-verdict` per case (the same answer again is current, a different one a conflict) and only
 * then reveals the model's choice. A verdict measures agreement and false positives; it changes no Run. A person only, at a real terminal, who may
 * administer policy in the scope; an AI principal is refused here and again by the audit writer.
 */
export class RecoveryReviewApplication {
  constructor(private readonly ports: RecoveryReviewPorts, private readonly registry: RecoveryRolloutRegistry = RECOVERY_ROLLOUT) {}
  private async person(principal: VerifiedPrincipal, scopeId: string) {
    if (isAiPrincipal(principal)) throw ErrorRegistry.createError('AI_AUTHORITY_NON_DELEGABLE');
    if (!await this.ports.interactive()) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    await this.ports.authorize(principal, scopeId);
  }
  async pending(input: unknown, principal: VerifiedPrincipal): Promise<readonly RecoveryReviewItem[]> {
    const { scopeId } = scopeSchema.parse(input), { scan } = this.registry;
    await this.person(principal, scopeId);
    const judged = new Set((await this.ports.listRecentKind(scopeId, 'recovery-verdict', 0, scan.verdicts)).flatMap(record =>
      record.event.subject.kind === 'recovery-verdict' ? [record.event.subject.caseId] : []));
    const items: RecoveryReviewItem[] = [];
    for (const record of await this.ports.listRecentKind(scopeId, 'recovery-decision', 0, scan.decisions)) {
      const subject = record.event.subject;
      if (items.length >= scan.reviewPage) break;
      if (subject.kind !== 'recovery-decision' || !recoveryModelDecided(subject) || judged.has(subject.caseId) || items.some(item => item.caseId === subject.caseId)) continue;
      const detection = (await this.ports.load(scopeId, `recovery-detection:${subject.caseId}`))?.event.subject;
      const seen = detection?.kind === 'recovery-detection' ? detection : null, run = await this.ports.loadRun(scopeId, subject.target.runId).catch(() => null);
      items.push(Object.freeze({ caseId: subject.caseId, decisionEventId: record.event.eventId, evidenceDigest: subject.evidenceDigest,
        rule: seen ? { id: seen.rule.id, version: seen.rule.version } : null, activity: seen?.evidence.activity ?? null, launcher: seen?.evidence.launcher ?? null,
        gate: subject.gate, runId: subject.target.runId, taskId: subject.target.taskId, wouldStop: subject.basis === 'would-stop', decidedAtMs: record.event.atMs,
        attempts: run ? (run.previousBindings ?? []).filter(row => row.identity.taskId === subject.target.taskId).length + 1 : null }));
    }
    return Object.freeze(items);
  }
  async answer(input: unknown, principal: VerifiedPrincipal): Promise<RecoveryVerdictOutcome> {
    const parsed = verdictSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('RECOVERY_TARGET_INVALID');
    const command = parsed.data, { scopeId, caseId } = command;
    await this.person(principal, scopeId);
    let decision: Readonly<{ eventId: string; subject: Decision }> | null = null;
    for (const eventId of [`recovery-decision:shadow:${caseId}`, `recovery-decision:${caseId}`]) {
      const subject = (await this.ports.load(scopeId, eventId))?.event.subject;
      if (subject?.kind === 'recovery-decision' && subject.caseId === caseId && recoveryModelDecided(subject)) { decision = { eventId, subject }; break; }
    }
    if (!decision) throw ErrorRegistry.createError('RECOVERY_TARGET_INVALID');
    const verdict = { kind: 'recovery-verdict' as const, caseId, decisionEventId: decision.eventId, evidenceDigest: decision.subject.evidenceDigest, detection: command.detection,
      choice: command.choice }, eventId = `recovery-verdict:${caseId}`;
    const held = (await this.ports.load(scopeId, eventId))?.event.subject;
    if (held && JSON.stringify(held) !== JSON.stringify(verdict)) throw ErrorRegistry.createError('RECOVERY_VERDICT_CONFLICT', { params: { case: caseId.slice(0, 12) } });
    if (!held) await this.ports.record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
      policyRevision: this.ports.policyRevision, atMs: this.ports.now(), subject: verdict } satisfies AuditEvent);
    const { action, causeClass } = decision.subject;
    return Object.freeze({ status: held ? 'current' as const : 'recorded' as const, caseId, detection: command.detection, choice: command.choice, model: { action, causeClass },
      agreed: command.choice === null ? null : command.choice === action });
  }
}
