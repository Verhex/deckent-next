import { z } from 'zod';
import { identitySchema, type AttemptIdentity, type RunSnapshot, type WorkerFinalReportResult, type WorkerModelView } from '#domain/index.js';
import { evaluatorEvidence } from '#capabilities/index.js';
import { redactForRecord, terminalSafeText, EMPTY_KNOWN_SECRETS, type KnownSecretSnapshot } from '#platform/index.js';
import riskAsset from '../../../../../assets/delivery-summary/risk.json' with { type: 'json' };
import { DELIVERY_SUMMARY_ACTIONS, DELIVERY_SUMMARY_LIMITS as LIMITS, deliveryChangeFactsSchema, deliverySummarySchema,
  type DeliveryChangeFacts, type DeliveryRiskFlag, type DeliverySummary, type DeliverySummaryOperation } from './contract.js';

/** Risk classification data (versioned asset): which frozen work classes count as `small` and the adapter size buckets, smallest first. */
export const deliveryRiskDataSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, smallWorkClasses: z.array(identitySchema).readonly(),
  sizeBuckets: z.array(z.object({ id: identitySchema, maxFiles: z.number().int().nonnegative().safe(), maxLines: z.number().int().nonnegative().safe() }).strict().readonly()).min(1).readonly(),
  overflowBucket: identitySchema }).strict().refine(value => new Set([...value.sizeBuckets.map(row => row.id), value.overflowBucket]).size === value.sizeBuckets.length + 1).readonly();
export type DeliveryRiskData = z.infer<typeof deliveryRiskDataSchema>;
export const DELIVERY_RISK_DATA: DeliveryRiskData = deliveryRiskDataSchema.parse(riskAsset);

/** Facts already read under the caller's authority; `'withheld'` = not readable by this principal, `null` = no such evidence. */
export type DeliverySummaryFacts = Readonly<{
  operation: DeliverySummaryOperation; identity: AttemptIdentity; run: RunSnapshot;
  target: Readonly<{ id: string; protected: boolean | null }> | null;
  report: WorkerFinalReportResult | 'withheld' | null;
  /** The pinned worker's model row; null when the task is not a pinned worker task. */
  model: WorkerModelView | 'withheld' | null;
  verification: Readonly<{ runId: string; run: RunSnapshot | null }> | 'withheld' | null;
  change: DeliveryChangeFacts | 'withheld' | null;
  /** Card bound for top paths (the surface's preview size); never above the envelope limit. */
  topPaths?: number; known?: KnownSecretSnapshot; risk?: DeliveryRiskData;
}>;

const codePoints = (value: string, max: number) => { const chars = Array.from(value); return { text: chars.slice(0, max).join(''), truncated: chars.length > max }; };
/** Neutralise terminal controls, redact (known secrets + record patterns) before bounding, so a cut never exposes half a secret. */
function safe(value: string, max: number, known: KnownSecretSnapshot) {
  return codePoints(redactForRecord(terminalSafeText(value), known).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim(), max);
}
function evidenceOf(run: RunSnapshot, taskId: string) {
  const task = run.graph.tasks.find(row => row.id === taskId), seen = new Map<string, DeliverySummary['acceptance']['evidence'][number]>();
  for (const id of task?.acceptanceCriteria ?? []) {
    const evaluator = run.graph.criterionDefinitions.find(row => row.id === id)?.evaluator;
    if (!evaluator || seen.has(`${evaluator.id}@${evaluator.version}`)) continue;
    const { kind, independent } = evaluatorEvidence(evaluator);
    seen.set(`${evaluator.id}@${evaluator.version}`, { evaluator: { id: evaluator.id, version: evaluator.version }, kind, independent });
  }
  return [...seen.values()].slice(0, LIMITS.evidenceKinds);
}
function verificationPhase(phase: RunSnapshot['progress'][number]['phase'] | undefined) {
  return phase === 'accepted' || phase === 'failed' || phase === 'cancelled' ? phase : phase === undefined || phase === 'reconciling' ? 'unknown' as const : 'pending' as const;
}
function sizeBucket(change: DeliveryChangeFacts, data: DeliveryRiskData) {
  const lines = change.added + change.removed;
  return data.sizeBuckets.find(row => change.paths.length <= row.maxFiles && lines <= row.maxLines)?.id ?? data.overflowBucket;
}

/** Pure projection of one delivery/adoption card. No I/O, clock, live registry or model call; same facts give the same envelope. */
export function projectDeliverySummary(facts: DeliverySummaryFacts): DeliverySummary {
  const known = facts.known ?? EMPTY_KNOWN_SECRETS, data = facts.risk ?? DELIVERY_RISK_DATA, { run, identity } = facts;
  const task = run.graph.tasks.find(row => row.id === identity.taskId), progress = run.progress.find(row => row.taskId === identity.taskId);
  const input = task?.workInput;
  const firstLine = input?.task.split('\n').map(line => safe(line, LIMITS.titleChars, known).text).find(Boolean);
  const titled = input?.title ? safe(input.title, LIMITS.titleChars, known).text : '';
  const title = titled ? { source: 'work-input' as const, text: titled } : firstLine ? { source: 'instruction' as const, text: firstLine } : { source: 'untitled' as const };

  const report = facts.report;
  const summary = report !== 'withheld' && report?.status === 'reported' ? safe(report.report.summary, LIMITS.outcomeChars, known) : null;
  const outcome = report === 'withheld' ? { state: 'withheld' as const } : summary
    ? { state: 'available' as const, claim: true as const, summary: summary.text, truncated: summary.truncated } : { state: 'unavailable' as const };
  const checks = report !== 'withheld' && report?.status === 'reported' ? report.report.checks : null;
  const worker = report === 'withheld' ? { state: 'withheld' as const } : checks ? { state: 'available' as const, claim: true as const,
    passed: checks.filter(row => row.outcome === 'passed').length, failed: checks.filter(row => row.outcome === 'failed').length,
    notRun: checks.filter(row => row.outcome === 'not-run').length, unknown: checks.filter(row => row.outcome === 'unknown').length } : { state: 'unavailable' as const };

  const verdict = progress?.phase === 'accepted' ? progress.acceptedEvidence === 'model-unverified' ? 'accepted-unverified' as const : 'accepted' as const
    : progress && ['failed', 'cancelled', 'skipped'].includes(progress.phase) ? 'not-accepted' as const : 'pending' as const;
  const acceptance = { verdict, criteriaCount: task?.acceptanceCriteria.length ?? 0, evidence: evidenceOf(run, identity.taskId) };

  const check = facts.verification;
  const verification = check === 'withheld' ? { state: 'withheld' as const } : check?.run ? { state: 'available' as const, runId: check.runId,
    phase: verificationPhase(check.run.progress.find(row => row.taskId === identity.taskId)?.phase ?? check.run.progress[0]?.phase),
    evidence: evidenceOf(check.run, check.run.graph.tasks.some(row => row.id === identity.taskId) ? identity.taskId : check.run.graph.tasks[0]?.id ?? '') } : { state: 'unavailable' as const };

  const view = facts.model;
  const model = view === 'withheld' || view?.evidence === 'denied' ? { state: 'withheld' as const } : view ? { state: 'available' as const,
    requested: { channelId: safe(view.requested.channelId, LIMITS.modelChars, known).text, modelId: safe(view.requested.modelId, LIMITS.modelChars, known).text },
    verdict: view.verdict } : { state: 'unavailable' as const };

  const changed = facts.change === 'withheld' || facts.change === null ? facts.change : deliveryChangeFactsSchema.parse(facts.change);
  const top = Math.max(0, Math.min(facts.topPaths ?? LIMITS.maxTopPaths, LIMITS.maxTopPaths));
  const change = changed === 'withheld' ? { state: 'withheld' as const } : changed ? { state: 'available' as const, adapter: changed.adapter,
    files: changed.paths.length, added: changed.added, removed: changed.removed,
    topPaths: changed.paths.slice(0, top).map(path => safe(path, LIMITS.pathChars, known).text), topPathsOmitted: Math.max(0, changed.paths.length - top),
    scope: changed.scope, outOfScope: changed.outOfScope.slice(0, LIMITS.maxOutOfScopePaths).map(path => safe(path, LIMITS.pathChars, known).text),
    outOfScopeCount: changed.outOfScope.length } : { state: 'unavailable' as const };

  const workClass = run.execution.tasks.find(row => row.taskId === identity.taskId)?.acceptance?.workClass ?? null;
  const flags: DeliveryRiskFlag[] = [];
  if (verdict === 'accepted-unverified') flags.push('acceptance-unverified');
  if (acceptance.evidence.length > 0 && !acceptance.evidence.some(row => row.independent === true)) flags.push('evidence-not-independent');
  if (model.state === 'available' && model.verdict !== 'verified') flags.push('model-not-verified');
  if (worker.state === 'available' && worker.failed > 0) flags.push('worker-checks-failed');
  if (verification.state === 'unavailable') flags.push('verification-missing');
  if (verification.state === 'available' && verification.phase !== 'accepted') flags.push('verification-not-accepted');
  if (change.state === 'available' && change.outOfScopeCount > 0) flags.push('out-of-scope');
  if (change.state === 'available' && change.scope === 'unscoped') flags.push('scope-undeclared');
  if (facts.target?.protected === true) flags.push('protected-target');

  return Object.freeze(deliverySummarySchema.parse({ schemaVersion: 1, operation: facts.operation, subject: identity,
    target: facts.target ? { state: 'available', id: safe(facts.target.id, LIMITS.targetChars, known).text, protected: facts.target.protected } : { state: 'unavailable' },
    title, outcome, acceptance, tests: { worker, verification }, model,
    risk: { class: workClass !== null && data.smallWorkClasses.includes(workClass) ? 'small' : 'other', workClass, protectedTarget: facts.target?.protected ?? null,
      sizeBucket: changed && changed !== 'withheld' ? sizeBucket(changed, data) : null, flags },
    actions: DELIVERY_SUMMARY_ACTIONS[facts.operation], change }));
}
