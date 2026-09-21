import { z } from 'zod';
import { taskInputNameSchema, runSnapshotSchema, attemptIdentitySchema, identitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { artifactReceiptSchema } from '#capabilities/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { DispatchError, verifyRetainedOutputEnvelope, type RunBoundDispatchStore, type DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { selectReservedTaskProfile, type RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
export const taskInputBindingSchema = z.object({ name: taskInputNameSchema,
  sourceAttemptId: identitySchema, output: taskInputNameSchema.optional(), receipt: artifactReceiptSchema }).strict().readonly();
export type TaskInputBinding = z.infer<typeof taskInputBindingSchema>;
/** Accepted direct dependencies only. Source content permission is independent of target execution. */
export class TaskInputApplication {
  constructor(private readonly store: Pick<RunStore, 'loadRun'> & Pick<AttemptStore, 'load'> & RunBoundDispatchStore,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization) {}
  async resolve(input: AttemptIdentity, credential?: unknown) {
    const identity = attemptIdentitySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('execute', identity, principal);
    const run = runSnapshotSchema.parse(await this.store.loadRun(identity.scopeId, identity.runId));
    selectReservedTaskProfile(run, await this.store.load(identity.scopeId, identity.attemptId), identity);
    const task = run.graph.tasks.find(value => value.id === identity.taskId)!;
    const result = [];
    for (const input of task.inputs ?? []) {
      const source = run.bindings.find(binding => binding.identity.taskId === input.taskId);
      if (!task.dependencies.includes(input.taskId) || !source || run.progress.find(value => value.taskId === input.taskId)?.phase !== 'accepted') {
        throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      }
      await this.authorization.authorizeIdentity('read-output', source.identity, principal);
      const dispatch = await this.store.loadBoundDispatch(source.identity);
      if (!dispatch?.output || !dispatch.terminal || !sameAttemptIdentity(dispatch.request.identity, source.identity)
        || dispatch.output.scopeId !== identity.scopeId) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
      result.push(Object.freeze({ source: source.identity, binding: taskInputBindingSchema.parse({ name: input.name,
        sourceAttemptId: source.identity.attemptId, ...(input.output ? { output: input.output } : {}), receipt: dispatch.output }) }));
    }
    return Object.freeze(result);
  }
}

/** Bytes were read using the ledger-bound receipt after authorization. Never accept a caller's digest. */
export function selectTaskInputArtifact(source: AttemptIdentity, input: TaskInputBinding, bytes: Uint8Array): TaskInputBinding {
  const binding = taskInputBindingSchema.parse(input);
  if (binding.sourceAttemptId !== source.attemptId || binding.receipt.scopeId !== source.scopeId) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  const envelope = verifyRetainedOutputEnvelope(bytes, source);
  if (!binding.output) return binding;
  const file = envelope.files?.find(file => file.name === binding.output);
  if (!file || file.status !== 'collected') throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
  return taskInputBindingSchema.parse({ ...binding, receipt: file.receipt });
}
