import { RECOVERY_ROLLOUT, recoveryRolloutView, type AuditRecord, type RecoveryRolloutRecords, type RecoveryRolloutRegistry, type RecoveryRolloutView,
  type RunSnapshot } from '#domain/index.js';

type Kind = 'recovery-detection' | 'recovery-decision' | 'recovery-verdict';
/** The sealed records the rollout and the review read: one scope's newest records of one kind (verified seals, newest first) and its Runs. */
export interface RecoveryRolloutPorts {
  listRecentKind(scopeId: string, kind: Kind, sinceAtMs: number, limit: number): readonly AuditRecord[] | Promise<readonly AuditRecord[]>;
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
}
type Subject<K extends Kind> = Extract<AuditRecord['event']['subject'], { kind: K }>;
const subjects = <K extends Kind>(page: readonly AuditRecord[], kind: K) => page.flatMap(record => record.event.subject.kind === kind
  ? [{ record, subject: record.event.subject as Subject<K> }] : []);
/** A model decision of a case (its call answered and was read; a live adoption of a shadow decision is the same call, so it is not a second one). */
export const recoveryModelDecided = (subject: Subject<'recovery-decision'>) => subject.model !== null && subject.failure === null && subject.basis !== 'shadow';
/**
 * Pure: the detected Attempt later had its worker's report accepted — the task is `accepted` with that Attempt still its current binding. A lost
 * worker cannot deliver (its output flows through its launcher), so the detection was a false positive. An exit that reached evaluation with
 * `report-missing`/`report-invalid` (a killed or orphaned worker) leaves the task failed or retried, never accepted: it is not a contradiction.
 */
export function recoveryReportAccepted(run: RunSnapshot | null, target: Readonly<{ taskId: string; attemptId: string }>): boolean {
  return run?.progress.some(task => task.taskId === target.taskId && task.phase === 'accepted') === true
    && run.bindings.some(row => row.identity.taskId === target.taskId && row.identity.attemptId === target.attemptId);
}

/** The sealed records of one scope's rollout, read within the registry scan bounds (`complete` false when any source hit its bound). */
export async function readRecoveryRolloutRecords(ports: RecoveryRolloutPorts, scopeId: string, rules: RecoveryRolloutRecords['rules'],
  registry: RecoveryRolloutRegistry = RECOVERY_ROLLOUT): Promise<RecoveryRolloutRecords> {
  const { scan } = registry, detected = await ports.listRecentKind(scopeId, 'recovery-detection', 0, scan.detections);
  const decided = await ports.listRecentKind(scopeId, 'recovery-decision', 0, scan.decisions), judged = await ports.listRecentKind(scopeId, 'recovery-verdict', 0, scan.verdicts);
  const detections = subjects(detected, 'recovery-detection').flatMap(({ record, subject }) => subject.target && registry.rules.includes(subject.rule.id)
    ? [{ caseId: subject.caseId, ruleId: subject.rule.id, ruleVersion: subject.rule.version, sequence: record.sequence, target: subject.target }] : []);
  const runs = new Map<string, Promise<RunSnapshot | null>>(), contradicted: string[] = [];
  for (const row of detections) {
    if (!runs.has(row.target.runId)) runs.set(row.target.runId, ports.loadRun(scopeId, row.target.runId).catch(() => null));
    if (recoveryReportAccepted(await runs.get(row.target.runId)!, row.target)) contradicted.push(row.caseId);
  }
  return Object.freeze({ rules, detections: detections.map(row => ({ caseId: row.caseId, ruleId: row.ruleId, ruleVersion: row.ruleVersion, sequence: row.sequence })), contradicted,
    decisions: subjects(decided, 'recovery-decision').flatMap(({ record, subject }) => recoveryModelDecided(subject) ? [{ caseId: subject.caseId, eventId: record.event.eventId, action: subject.action }] : []),
    verdicts: subjects(judged, 'recovery-verdict').map(({ subject }) => ({ caseId: subject.caseId, decisionEventId: subject.decisionEventId, detection: subject.detection, choice: subject.choice })),
    complete: detected.length < scan.detections && decided.length < scan.decisions && judged.length < scan.verdicts });
}
/** alpha.56 G4: one scope's rollout view, measured only from sealed records (read-only). */
export async function readRecoveryRollout(ports: RecoveryRolloutPorts, scopeId: string, rules: RecoveryRolloutRecords['rules'],
  registry: RecoveryRolloutRegistry = RECOVERY_ROLLOUT): Promise<RecoveryRolloutView> {
  return recoveryRolloutView(await readRecoveryRolloutRecords(ports, scopeId, rules, registry), registry);
}
