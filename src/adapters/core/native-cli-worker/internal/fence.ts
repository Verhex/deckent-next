import { sameAttemptIdentity, type AttemptIdentity, type AttemptSnapshot, type RunSnapshot } from '#domain/index.js';
import { dispatchFenceReceiptId, type DispatchRecord } from '#engine/index.js';

/** Read-only custody inputs; a fence/unknown identity never grants work, including before the CLI is spawned. */
export interface NativeCliWorkerFenceReader {
  loadRun(scopeId: string, runId: string): Promise<Pick<RunSnapshot, 'state' | 'cancelRequested'> | null>;
  load(scopeId: string, attemptId: string): Promise<Pick<AttemptSnapshot, 'identity' | 'cancelRequested'> | null>;
  loadBoundDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null>;
  loadRunReceipt(scopeId: string, commandId: string): Promise<unknown>;
}
export async function nativeCliWorkerFence(reader: NativeCliWorkerFenceReader, identity: AttemptIdentity): Promise<boolean> {
  const [run, attempt, dispatch] = await Promise.all([reader.loadRun(identity.scopeId, identity.runId), reader.load(identity.scopeId, identity.attemptId), reader.loadBoundDispatch(identity)]);
  return run?.state.kind === 'running' && !run.cancelRequested && !!attempt && sameAttemptIdentity(attempt.identity, identity) && !attempt.cancelRequested
    && !dispatch?.cancellation && !dispatch?.terminal && (!dispatch || !await reader.loadRunReceipt(identity.scopeId, dispatchFenceReceiptId(identity, dispatch.owner)));
}
