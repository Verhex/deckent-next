import { z } from 'zod';
import { DISPATCH_PREPARATION_PHASES, NERVOUS_ACTIVITY_STATES, NERVOUS_RULE_STATUSES, NERVOUS_LAUNCHER_BASES, attemptIdentitySchema, counterSchema, recoveryEvidenceSchema, encodeCommandProjection,
  identitySchema, recoveryActionSchema, type AuditEvent } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { NervousRule, NervousRules } from './rules.js';

/**
 * S6R-2 detection input, gathered read-only by composition from existing signals: the supervisor's activity sample of one granted, unsettled,
 * unfenced dispatch (`control-failed`: the daemon did not answer) and its launcher (`dead`: the preparation record or captured launcher evidence
 * names another instance whose process is gone; `alive`/`same-process` never fire; `none`/`unreadable` prove nothing). `fenced` (S6R-3): the
 * dispatch already carries a fence, so its signal only re-applies a sealed case (stop issued, proof pending; a crash between seal and effect).
 */
export const nervousAttemptSignalSchema = z.object({ identity: attemptIdentitySchema, activity: z.enum(NERVOUS_ACTIVITY_STATES),
  launcher: z.object({ basis: z.enum(NERVOUS_LAUNCHER_BASES), phase: z.enum(DISPATCH_PREPARATION_PHASES).nullable() }).strict(),
  containerRecorded: z.boolean(), workerRecorded: z.boolean(), fenced: z.boolean().optional() }).strict().readonly();
export type NervousAttemptSignal = z.infer<typeof nervousAttemptSignalSchema>;
export type NervousEvidence = z.infer<typeof recoveryEvidenceSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** One typed proposal: the rule that fired, the one K-B action it names and what it names it for (an Attempt, a task's Attempt from an audit event, or the scope). */
export const nervousProposalSchema = z.object({ schemaVersion: z.literal(1), caseId: digest, scopeId: identitySchema,
  rule: z.object({ id: identitySchema, version: counterSchema.positive(), status: z.enum(NERVOUS_RULE_STATUSES) }).strict(), registryRevision: identitySchema,
  action: recoveryActionSchema, target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('attempt'), identity: attemptIdentitySchema }).strict(),
    z.object({ kind: z.literal('task'), runId: identitySchema, taskId: identitySchema, attemptId: identitySchema }).strict(), z.object({ kind: z.literal('scope') }).strict()]),
  evidence: recoveryEvidenceSchema, evidenceDigest: digest }).strict().readonly();
export type NervousProposal = z.infer<typeof nervousProposalSchema>;
export type NervousTarget = NervousProposal['target'];
/** Per-process series of absent samples of one Attempt (memory only: a restart starts it again, which only delays a fire). */
export type NervousAbsence = Readonly<{ count: number; sinceMs: number }>;

const EMPTY: NervousEvidence = Object.freeze({ activity: null, launcher: null, launcherPhase: null, absentObservations: 0, absentForMs: null, unavailableForMs: null,
  containerRecorded: null, workerRecorded: null, source: null });
/** Case identity (design §8): the Attempt (or task/scope) and the rule, plus what makes a scope case distinct (outage start, source event). */
export function nervousCaseId(scopeId: string, ruleId: string, target: NervousTarget, distinct: string | number | null = null): string {
  return sha256(encodeCommandProjection('recovery-case:1', { scopeId, ruleId, target, distinct }));
}
export function nervousProposal(scopeId: string, rules: NervousRules, rule: NervousRule, target: NervousTarget, evidence: Partial<NervousEvidence>,
  distinct: string | number | null = null): NervousProposal {
  const full = { ...EMPTY, ...evidence };
  return nervousProposalSchema.parse({ schemaVersion: 1, caseId: nervousCaseId(scopeId, rule.id, target, distinct), scopeId,
    rule: { id: rule.id, version: rule.version, status: rule.status }, registryRevision: rules.revision, action: rule.action, target, evidence: full,
    evidenceDigest: sha256(encodeCommandProjection('recovery-evidence:1', { target, evidence: full })) });
}
/** The next absence series of one Attempt: a missing sample extends it, any other sample ends it. */
export function advanceNervousAbsence(previous: NervousAbsence | undefined, signal: NervousAttemptSignal, nowMs: number): NervousAbsence | undefined {
  if (signal.activity !== 'missing') return undefined;
  return previous ? { count: previous.count + 1, sinceMs: previous.sinceMs } : { count: 1, sinceMs: nowMs };
}
/** At most one proposal per Attempt and observation, most specific rule first: a dead launcher's orphan or gone container, then a container gone for k samples. */
export function detectNervousAttempt(rules: NervousRules, signal: NervousAttemptSignal, absence: NervousAbsence | undefined, nowMs: number): NervousProposal | null {
  const { identity } = signal, target = { kind: 'attempt' as const, identity }, evidence = { activity: signal.activity, launcher: signal.launcher.basis,
    launcherPhase: signal.launcher.phase, absentObservations: absence?.count ?? 0, absentForMs: absence ? nowMs - absence.sinceMs : null,
    containerRecorded: signal.containerRecorded, workerRecorded: signal.workerRecorded };
  // A dead launcher counts only at `dispatch`, the phase its worker runs in; any other phase on a granted dispatch is inconsistent evidence (lead, s6 Q2).
  const dead = signal.launcher.basis === 'dead' && signal.launcher.phase === 'dispatch';
  if (dead && ['running', 'created', 'paused'].includes(signal.activity)) return nervousProposal(identity.scopeId, rules, rules.rule('launcher-dead-orphan'), target, evidence);
  if (dead && signal.activity === 'missing') return nervousProposal(identity.scopeId, rules, rules.rule('launcher-dead-gone'), target, evidence);
  const gone = rules.rule('container-gone');
  if (absence && absence.count >= gone.consecutiveAbsent && nowMs - absence.sinceMs >= gone.minAbsentMs) return nervousProposal(identity.scopeId, rules, gone, target, evidence);
  return null;
}
/** Scope outage: the daemon answered none of this batch's samples (a successful sample ends it). Alert after the grace, a person after escalation. */
export function detectNervousOutage(rules: NervousRules, scopeId: string, sinceMs: number, nowMs: number): readonly NervousProposal[] {
  const elapsed = nowMs - sinceMs, evidence = { activity: 'control-failed' as const, unavailableForMs: elapsed };
  return [rules.rule('daemon-unavailable'), rules.rule('daemon-unavailable-escalate')]
    .filter(rule => elapsed >= (rule.id === 'daemon-unavailable' ? rule.graceMs : rule.afterMs))
    .map(rule => nervousProposal(scopeId, rules, rule, { kind: 'scope' }, evidence, sinceMs));
}
export type NervousFeedKind = 'dispatch-preparation-aborted' | 'policy-turn';
/** Audit feed rules: a crash-loop breaker at its bound (diagnosis for a person; resume stays human, s5b), a policy-turn past its refusal ceiling. */
export function detectNervousFeed(rules: NervousRules, record: Readonly<{ sequence: number; event: AuditEvent }>): NervousProposal | null {
  const { event, sequence } = record, subject = event.subject, source = { kind: subject.kind as NervousFeedKind, eventId: event.eventId, sequence };
  if (subject.kind === 'dispatch-preparation-aborted' && subject.aborts >= subject.bound) return nervousProposal(event.scopeId, rules, rules.rule('crash-loop'),
    { kind: 'task', runId: subject.runId, taskId: subject.taskId, attemptId: subject.attemptId }, { launcherPhase: subject.phase, source }, event.eventId);
  if (subject.kind === 'policy-turn' && subject.ceiling) return nervousProposal(event.scopeId, rules, rules.rule('policy-refusal-flood'), { kind: 'scope' }, { source }, event.eventId);
  return null;
}
