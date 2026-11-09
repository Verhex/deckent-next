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
import { resolveTaskInputs, selectTaskInputArtifact } from './resolve.js';
import { resolveTaskHandoff } from './handoff.js';
import { resolveTaskPatches } from './patch-start.js';
import { TaskStartApplication, assertTaskStartContext, type TaskStartContext } from './open.js';
type StartArtifacts = ArtifactStore & { prepareReadOnlyFile(scopeId: string, receipt: import('#capabilities/index.js').ArtifactReceipt): Promise<{ path: string; bytes: Uint8Array }> };
type StartStore = Partial<TaskHandoffEvidenceStore> & Pick<RunStore, 'loadRun'> & AttemptStore & RunBoundDispatchStore;
type StartConfig = { artifacts: { maxInputs: number; maxBytes: number } };
/** Trusted paths are prepared from exact ledger receipts; the engine owns accepted source selection. */
export async function prepareTaskStart(identity: AttemptIdentity, store: StartStore, artifacts: StartArtifacts,
  verifier: PrincipalVerifier, authorization: DispatchIdentityAuthorization, config: StartConfig) {
  const context = await new TaskStartApplication(store, verifier, authorization).open(identity);
  return prepareOpenedTaskStart(context, store, artifacts, authorization, config);
}
/** Internal continuation of the authenticated open; never a wire-input entry point. */
export async function prepareOpenedTaskStart(context: TaskStartContext, store: StartStore, artifacts: StartArtifacts,
  authorization: DispatchIdentityAuthorization, config: StartConfig) {
  assertTaskStartContext(context, store, authorization);
  const { identity, run, principal } = context;
  const count = run?.graph.tasks.find(task => task.id === identity.taskId)?.inputs?.length ?? 0;
  if (count > config.artifacts.maxInputs) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  const declarations = await resolveTaskInputs(context, store, authorization);
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
  await authorization.authorizeIdentity('execute', identity, principal);
  const handoff = await resolveTaskHandoff(context, store, authorization, artifacts, { maxBytes: Math.min(remaining, workerReportLimits.deliveredInputBytes),
    maxSourceBytes: config.artifacts.maxBytes, maxSharedNotes: workerReportLimits.runSharedNotes, promptBytes: workerReportLimits.promptBytes });
  if (inputs.some(input => input.name === '_handoff') && handoff.files.some(file => file.target.startsWith('/deckent/inputs/_handoff/'))) throw new HandoffError('HANDOFF_INVALID');
  const handoffInputs = [];
  for (const file of handoff.files) handoffInputs.push({ ...file, path: (await artifacts.prepareReadOnlyFile(identity.scopeId, file.receipt)).path });
  await authorization.authorizeIdentity('execute', identity, principal);
  const patches = await resolveTaskPatches(context, store, authorization, artifacts, config.artifacts.maxBytes);
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
/** Owner 2026-11-05 (R9n): the worker learns which of the project's current files its working-tree base withheld (S6 deny, patch exclusion,
 * product state, unsafe entry or size) as one labelled data line after its context: path and rule only, at most `shown` paths, the count always. */
export function withheldBaseStart<T extends { readonly dependencyContext?: Readonly<{ text: string; sha256: string }> }>(start: T, count: number,
  excluded: readonly Readonly<{ path: string; rule: string }>[], shown: number): T {
  if (!count) return start;
  const line = (paths: readonly unknown[]) => JSON.stringify({ kind: 'workspace-files-withheld', count, paths });
  const text = [start.dependencyContext?.text, line(excluded.slice(0, shown))].filter(Boolean).join('\n'), fits = Buffer.byteLength(text) <= workerReportLimits.promptBytes;
  const prompt = fits ? text : [start.dependencyContext?.text, line([])].filter(Boolean).join('\n');
  return { ...start, dependencyContext: { text: prompt, sha256: createHash('sha256').update(prompt).digest('hex') } };
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
