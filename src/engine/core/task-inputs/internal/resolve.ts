import { TaskStartApplication, type TaskStartContext } from './open.js';
import { z } from 'zod';
import { taskInputNameSchema, identitySchema, sameAttemptIdentity, taskDependencyIds, type AttemptIdentity } from '#domain/index.js';
import { artifactReceiptSchema } from '#capabilities/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';
import { DispatchError, verifyRetainedOutputEnvelope, type RunBoundDispatchStore, type DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
export const taskInputBindingSchema = z.strictObject({ name: taskInputNameSchema,
  sourceAttemptId: identitySchema, output: taskInputNameSchema.optional(), receipt: artifactReceiptSchema }).readonly();
export type TaskInputBinding = z.infer<typeof taskInputBindingSchema>;
type Store = Pick<RunStore, 'loadRun'> & Pick<AttemptStore, 'load'> & RunBoundDispatchStore;
/** Accepted direct dependencies only. Source content permission is independent of target execution. */
export class TaskInputApplication {
  constructor(private readonly store: Store,
    private readonly verifier: PrincipalVerifier, private readonly authorization: DispatchIdentityAuthorization) {}
  async resolve(input: AttemptIdentity, credential?: unknown) {
    const context = await new TaskStartApplication(this.store, this.verifier, this.authorization).open(input, credential);
    return resolveTaskInputs(context, this.store, this.authorization);
  }
}
export async function resolveTaskInputs(context: TaskStartContext, store: Store, authorization: DispatchIdentityAuthorization) {
  const { identity, principal, run } = context;
  const task = run.graph.tasks.find(value => value.id === identity.taskId)!;
  const result = [];
  for (const input of task.inputs ?? []) {
    const source = run.bindings.find(binding => binding.identity.taskId === input.taskId);
    if (!taskDependencyIds(task).includes(input.taskId) || !source || run.progress.find(value => value.taskId === input.taskId)?.phase !== 'accepted') {
      throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
    }
    await authorization.authorizeIdentity('read-output', source.identity, principal);
    const dispatch = await store.loadBoundDispatch(source.identity);
    if (!dispatch?.output || !dispatch.terminal || !sameAttemptIdentity(dispatch.request.identity, source.identity)
      || dispatch.output.scopeId !== identity.scopeId) throw new DispatchError('DISPATCH_ARTIFACT_REQUIRED');
    result.push(Object.freeze({ source: source.identity, binding: taskInputBindingSchema.parse({ name: input.name,
      sourceAttemptId: source.identity.attemptId, ...(input.output ? { output: input.output } : {}), receipt: dispatch.output }) }));
  }
  return Object.freeze(result);
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
