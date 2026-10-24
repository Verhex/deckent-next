import { createHash } from 'node:crypto';
import type { AttemptIdentity } from '#domain/index.js';
import { RECOVERY_DECISION_SEED, loadRecoveryDecisionRegistry, recoveryNoteText, workerReportLimits, type RunSnapshot } from '#domain/index.js';
import { HandoffError } from '#engine/core/handoff-observation/index.js';
import type { TaskHandoffEvidenceStore } from './handoff.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import type { RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';
import { DispatchError, type DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { TaskInputApplication, selectTaskInputArtifact, TaskHandoffApplication, TaskPatchStartApplication
 } from '#engine/core/task-inputs/index.js';
type StartArtifacts = ArtifactStore & { prepareReadOnlyFile(scopeId: string, receipt: import('#capabilities/index.js').ArtifactReceipt): Promise<{ path: string; bytes: Uint8Array }> };
type StartStore = Partial<TaskHandoffEvidenceStore> & Pick<RunStore, 'loadRun'> & AttemptStore & RunBoundDispatchStore;
type StartConfig = { artifacts: { maxInputs: number; maxBytes: number } };
/** Trusted paths are prepared from exact ledger receipts; the engine owns accepted source selection. */
export async function prepareTaskStart(identity: AttemptIdentity, store: StartStore, artifacts: StartArtifacts,
  verifier: PrincipalVerifier, authorization: DispatchIdentityAuthorization, config: StartConfig) {
  const run = await store.loadRun(identity.scopeId, identity.runId);
  const count = run?.graph.tasks.find(task => task.id === identity.taskId)?.inputs?.length ?? 0;
  if (count > config.artifacts.maxInputs) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  const declarations = count ? await new TaskInputApplication(store, verifier, authorization).resolve(identity) : [];
  let remaining = config.artifacts.maxBytes;
  for (const { binding } of declarations) {
    if (binding.receipt.byteLength > remaining) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
    remaining -= binding.receipt.byteLength;
  }
  const inputs = [];
  for (const { source, binding } of declarations) {
    const prepared = await artifacts.prepareReadOnlyFile(identity.scopeId, binding.receipt);
    const selected = selectTaskInputArtifact(source, binding, prepared.bytes);
    if (binding.output) {
      if (selected.receipt.byteLength > remaining) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      remaining -= selected.receipt.byteLength;
    }
    inputs.push({ ...selected, path: binding.output ? (await artifacts.prepareReadOnlyFile(identity.scopeId, selected.receipt)).path : prepared.path });
  }
  const handoff = await new TaskHandoffApplication(store, verifier, authorization, artifacts, { maxBytes: Math.min(remaining, workerReportLimits.deliveredInputBytes),
    maxSourceBytes: config.artifacts.maxBytes, maxSharedNotes: workerReportLimits.runSharedNotes, promptBytes: workerReportLimits.promptBytes }).resolve(identity);
  if (inputs.some(input => input.name === '_handoff') && handoff.files.some(file => file.target.startsWith('/deckent/inputs/_handoff/'))) throw new HandoffError('HANDOFF_INVALID');
  const handoffInputs = [];
  for (const file of handoff.files) handoffInputs.push({ ...file, path: (await artifacts.prepareReadOnlyFile(identity.scopeId, file.receipt)).path });
  const patches = await new TaskPatchStartApplication(store, artifacts, verifier, authorization, config.artifacts.maxBytes).resolve(identity);
  const answer = run?.progress.find(task => task.taskId === identity.taskId)?.inputAnswer;
  if (answer && (identity.generation !== answer.source.generation + 1 || identity.attemptId === answer.source.attemptId)) throw new HandoffError('HANDOFF_INVALID');
  const continuation = answer ? JSON.stringify({ kind: 'human-input-answer', ...answer }) : '';
  const prompt = [handoff.prompt, continuation, recoveryContinuation(run, identity)].filter(Boolean).join('\n');
  if (Buffer.byteLength(prompt) > workerReportLimits.promptBytes) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
  if (answer) {
    const bytes = new TextEncoder().encode(continuation);
    if (bytes.byteLength + handoff.files.reduce((sum, file) => sum + file.receipt.byteLength, 0) > remaining
      || bytes.byteLength + handoff.files.reduce((sum, file) => sum + file.receipt.byteLength, 0) > workerReportLimits.deliveredInputBytes
      || handoffInputs.some(file => file.target === '/deckent/inputs/_needs-input.json')) throw new HandoffError('HANDOFF_LIMIT_EXCEEDED');
    const receipt = await artifacts.put(identity.scopeId, bytes);
    handoffInputs.push({ target: '/deckent/inputs/_needs-input.json', receipt, path: (await artifacts.prepareReadOnlyFile(identity.scopeId, receipt)).path });
  }
  return { declarations, inputs, handoffInputs, patches, events: handoff.events,
    ...(prompt ? { dependencyContext: { text: prompt, sha256: createHash('sha256').update(prompt).digest('hex') } } : {}) };
}
/**
 * S6R-5 (S6R-DESIGN §6, §7 step 4b): what the Attempt that continues a lost one learns of it, as one labelled data line — the decision's registry note
 * (its code and worker-facing registry text; never model text) and the settled task-idempotent work the gate saw (never re-executed; a repeat dedups
 * at the target through the task-scoped key). Only for the generation right after the lost binding; it grants nothing.
 */
function recoveryContinuation(run: RunSnapshot | null, identity: AttemptIdentity): string {
  const lost = [...run?.previousBindings ?? []].reverse().find(row => row.identity.taskId === identity.taskId && row.observedKind === 'lost');
  const context = lost?.recoveryContext;
  if (!context || lost.identity.generation + 1 !== identity.generation) return '';
  const note = context.note === null ? null : { code: context.note, text: recoveryNoteText(loadRecoveryDecisionRegistry(RECOVERY_DECISION_SEED), context.note) };
  return JSON.stringify({ kind: 'recovery-continuation', note, settledWork: context.facts });
}
