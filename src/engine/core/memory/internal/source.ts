import { createHash } from 'node:crypto';
import { encodeDeckentJson, memoryDistillerPrincipal, memoryEvaluatorPrincipal, memoryWorkClassOf, readWorkerFinalReport, readWorkerModelPin, sameAttemptIdentity, type JsonValue, type MemoryExtractionSource,
  type MemoryModelRef, type RunSnapshot, type TaskEvaluation, type WorkClassRegistry } from '#domain/index.js';
import { verifyRetainedOutputEnvelope } from '#engine/core/dispatch/index.js';
import type { MemoryEvaluationSource } from './contract.js';

/**
 * S4B-1 §4.1: one distiller source from sealed records only — the Run snapshot, the canonical evaluation of the Attempt and the effect ledger's
 * answer whether the Attempt left an unresolved effect. `accepted` needs the Task accepted and this Attempt the evaluated, bound one; E1's answer is
 * the person's answer to the earlier generation's question when this Attempt is the next generation. The worker report's `lessons` (S4B-2, rule E3) arrive as `report`,
 * read from the sealed output (`memoryReportClaimsOf`), null without one; the typed earlier failure (rule E2) is not read yet (null, tracked follow-up). The work target is the Run's (null: none); the WorkClass view is the caller's registry projection.
 */
export function memoryExtractionSourceOf(input: { readonly run: RunSnapshot; readonly attemptId: string; readonly evaluations: readonly TaskEvaluation[];
  readonly unsettledEffects: boolean; readonly workClass: MemoryExtractionSource['workClass']; readonly workTargetId: string | null;
  readonly report?: MemoryReportClaims | null }): MemoryExtractionSource | null {
  const { run } = input, binding = run.bindings.find(row => row.identity.attemptId === input.attemptId);
  if (!binding) return null;
  const evaluation = input.evaluations.find(row => sameAttemptIdentity(row.identity, binding.identity));
  if (!evaluation) return null;
  const task = run.progress.find(row => row.taskId === binding.identity.taskId), answer = task?.inputAnswer;
  return { schemaVersion: 1, scopeId: run.identity.scopeId, runId: run.identity.runId, taskId: binding.identity.taskId, attemptId: binding.identity.attemptId,
    generation: binding.identity.generation, workClass: input.workClass, workTargetId: input.workTargetId,
    evaluation: { id: evaluation.evaluationId, digest: createHash('sha256').update(encodeDeckentJson(evaluation as unknown as JsonValue)).digest('hex') },
    accepted: task?.phase === 'accepted', settled: !input.unsettledEffects,
    inputAnswer: answer && answer.source.generation + 1 === binding.identity.generation ? { question: answer.question, answer: answer.answer } : null,
    earlierFailure: null, lessons: input.report?.lessons ?? null, reportDigest: input.report?.reportDigest ?? null };
}
/** S4B-2 rule E3's input: the worker's `lessons` claims and the digest of the sealed report they came from. Claims only (§4.4). */
export interface MemoryReportClaims { readonly lessons: readonly unknown[] | null; readonly reportDigest: string }
/**
 * S4B-2 (§4.1, E3): the lesson claims of one Attempt's sealed output, read exactly as handoff reads it — the bytes must match the receipt, the
 * envelope must belong to the Attempt, and the report must be a valid `reported` one (a missing, invalid or oversized report, or one whose malformed `lessons` were dropped
 * yields no claims). No claims (absent or empty) is `null`: the report still seals nothing for memory. Throws only on a mismatch the caller maps to none.
 */
export function memoryReportClaimsOf(receipt: { readonly byteLength: number; readonly digest: string }, bytes: Uint8Array, identity: unknown): MemoryReportClaims | null {
  if (bytes.byteLength !== receipt.byteLength || createHash('sha256').update(bytes).digest('hex') !== receipt.digest) return null;
  let stdout: string;
  try { stdout = verifyRetainedOutputEnvelope(bytes, identity).stdout; } catch { return null; }
  const report = readWorkerFinalReport(stdout);
  if (report.status !== 'reported' || !report.report.lessons?.length) return null;
  return { lessons: report.report.lessons, reportDigest: createHash('sha256').update(encodeDeckentJson(report.report as unknown as JsonValue)).digest('hex') };
}
/** The composition root's distiller identity for one scope (the installation owner's `<issuer>/memory-distiller`, workload-verified). */
export const memoryDistillerFor = (owner: { readonly issuer: string; readonly subject: string }, scopeId: string) => memoryDistillerPrincipal(owner, [scopeId]);
/** The distiller's WorkClass view (id, family, risk) from the installation's registry overlay (absent: the Core seed). */
export const memoryWorkClassView = (configured: WorkClassRegistry | undefined, classId: string | null) => memoryWorkClassOf(configured, classId);

/** The composition root's evaluator identity for one scope (`<issuer>/memory-evaluator`, workload-verified; S4B-3 A4). */
export const memoryEvaluatorFor = (owner: { readonly issuer: string; readonly subject: string }, scopeId: string) => memoryEvaluatorPrincipal(owner, [scopeId]);
/**
 * S4B-3 §6.3: one support row's sealed source for the evaluator — accepted and settled as the distiller saw it, the canonical evaluation's
 * criteria verdicts (no raw worker output), and the worker models re-derived from the Run's frozen execution snapshot: the pinned model and every
 * auxiliary model it declares, the system assignment's model, and every name the sealed evaluation recorded the worker reporting (init, usage,
 * unexpected) on the pinned channel. Each gets its canonical maker from `makerOf` (null: unknown, which fails independence closed).
 */
export function memoryEvaluationSourceOf(input: { readonly run: RunSnapshot; readonly attemptId: string; readonly evaluations: readonly TaskEvaluation[];
  readonly unsettledEffects: boolean; makerOf(channelId: string, modelId: string): string | null }): MemoryEvaluationSource | null {
  const { run } = input, binding = run.bindings.find(row => row.identity.attemptId === input.attemptId);
  const evaluation = binding && input.evaluations.find(row => sameAttemptIdentity(row.identity, binding.identity));
  if (!binding || !evaluation) return null;
  const task = run.execution.tasks.find(row => row.taskId === binding.identity.taskId), pin = readWorkerModelPin(task?.profile.parameters)?.pin;
  const reported = evaluation.model ? [evaluation.model.init, ...(evaluation.model.usage ?? []), ...evaluation.model.unexpected].filter((name): name is string => !!name) : [];
  const named: [string, string][] = [...(pin ? [pin.modelId, ...pin.auxiliaryModelIds, ...reported].map(id => [pin.channelId, id] as [string, string]) : []),
    ...(task?.assignment ? [[task.assignment.channelId, task.assignment.modelId] as [string, string]] : [])];
  const models = new Map<string, MemoryModelRef>();
  for (const [channelId, modelId] of named) models.set(JSON.stringify([channelId, modelId]), { channelId, modelId, maker: input.makerOf(channelId, modelId) });
  return { accepted: run.progress.find(row => row.taskId === binding.identity.taskId)?.phase === 'accepted', settled: !input.unsettledEffects, evaluationId: evaluation.evaluationId,
    criteria: evaluation.criteria.map(row => ({ criterionId: row.criterionId, status: row.verdict })), models: [...models.values()] };
}
