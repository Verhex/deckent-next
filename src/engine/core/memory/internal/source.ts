import { createHash } from 'node:crypto';
import { encodeDeckentJson, memoryDistillerPrincipal, memoryWorkClassOf, sameAttemptIdentity, type JsonValue, type MemoryExtractionSource, type RunSnapshot, type TaskEvaluation,
  type WorkClassRegistry } from '#domain/index.js';

/**
 * S4B-1 §4.1: one distiller source from sealed records only — the Run snapshot, the canonical evaluation of the Attempt and the effect ledger's
 * answer whether the Attempt left an unresolved effect. `accepted` needs the Task accepted and this Attempt the evaluated, bound one; E1's answer is
 * the person's answer to the earlier generation's question when this Attempt is the next generation. The worker report's `lessons` and the typed
 * earlier failure are S4B-2's (null here). The work target is the Run's (null: none); the WorkClass view is the caller's registry projection.
 */
export function memoryExtractionSourceOf(input: { readonly run: RunSnapshot; readonly attemptId: string; readonly evaluations: readonly TaskEvaluation[];
  readonly unsettledEffects: boolean; readonly workClass: MemoryExtractionSource['workClass']; readonly workTargetId: string | null }): MemoryExtractionSource | null {
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
    earlierFailure: null, lessons: null, reportDigest: null };
}
/** The composition root's distiller identity for one scope (the installation owner's `<issuer>/memory-distiller`, workload-verified). */
export const memoryDistillerFor = (owner: { readonly issuer: string; readonly subject: string }, scopeId: string) => memoryDistillerPrincipal(owner, [scopeId]);
/** The distiller's WorkClass view (id, family, risk) from the installation's registry overlay (absent: the Core seed). */
export const memoryWorkClassView = (configured: WorkClassRegistry | undefined, classId: string | null) => memoryWorkClassOf(configured, classId);
