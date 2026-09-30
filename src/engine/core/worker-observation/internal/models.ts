import { readWorkerModelPin, summarizeWorkerEvents, viewWorkerModels, workerEventSchema, type AttemptIdentity, type RunSnapshot,
  type VerifiedPrincipal, type WorkerEvent, type WorkerEventSummary, type WorkerModelView } from '#domain/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { WorkerObservationError, type WorkerEventLogStore } from './contract.js';
import type { WorkerEventArtifacts } from './transcript.js';

type SealedLogs = Pick<WorkerEventLogStore, 'loadWorkerEventLog'>;
const denied = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED'].includes(String(error.code));
/** Sealed, redacted events of one attempt, or null without a sealed log. A log that is not an event stream of this attempt is invalid. */
export async function readSealedWorkerEvents(store: SealedLogs, artifacts: WorkerEventArtifacts, identity: AttemptIdentity): Promise<readonly WorkerEvent[] | null> {
  const log = await store.loadWorkerEventLog(identity.scopeId, identity.attemptId);
  if (!log) return null;
  if (JSON.stringify(log.identity) !== JSON.stringify(identity)) throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(identity.scopeId, log.events));
    return Object.freeze(text.split('\n').filter(Boolean).map(line => workerEventSchema.parse(JSON.parse(line))));
  } catch { throw new WorkerObservationError('WORKER_OBSERVATION_INVALID'); }
}

/** One model row per pinned task of a Run (WORKER-CURRENCY-2); `attemptId` null before a task is bound. */
export type TaskWorkerModel = WorkerModelView & Readonly<{ taskId: string; attemptId: string | null }>;
type PinnedRun = Pick<RunSnapshot, 'execution' | 'bindings'>;
/** Requested (the Run's frozen pin) → init → usage → verdict from already read evidence: sealed events win, else the live projection (`pending`). */
export function projectAttemptWorkerModels(run: PinnedRun, taskId: string, sealed: readonly WorkerEvent[] | null, live: WorkerEventSummary | null = null): WorkerModelView | null {
  const pinned = readWorkerModelPin(run.execution.tasks.find(task => task.taskId === taskId)?.profile.parameters);
  if (!pinned) return null;
  return viewWorkerModels({ ...pinned, summary: sealed ? summarizeWorkerEvents(sealed) : live, evidence: sealed ? 'sealed' : live ? 'live' : 'none' });
}
/** The same row read from the ledger (null when the task is not a pinned worker task). Reading sealed evidence is the caller's `read-output` decision. */
export async function describeAttemptWorkerModels(run: PinnedRun, identity: AttemptIdentity, store: SealedLogs, artifacts: WorkerEventArtifacts,
  live: WorkerEventSummary | null = null): Promise<WorkerModelView | null> {
  const pinned = readWorkerModelPin(run.execution.tasks.find(task => task.taskId === identity.taskId)?.profile.parameters);
  if (!pinned) return null;
  let sealed;
  try { sealed = await readSealedWorkerEvents(store, artifacts, identity); }
  catch (error) {
    if (!(error instanceof WorkerObservationError)) throw error;
    return viewWorkerModels({ ...pinned, summary: null, evidence: 'invalid' });
  }
  return projectAttemptWorkerModels(run, identity.taskId, sealed, live);
}
/** Model row of an observed attempt from the ledger (the Run's pin; sealed verdict, else live `pending`): null when not a pinned worker task,
 * undefined when the row could not be read (the observation reports a diagnostic instead). */
export async function observeAttemptWorkerModels(ledger: SealedLogs & { loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null> },
  artifacts: WorkerEventArtifacts, identity: AttemptIdentity, live: WorkerEventSummary | null): Promise<WorkerModelView | null | undefined> {
  try {
    const run = await ledger.loadRun(identity.scopeId, identity.runId);
    return run ? await describeAttemptWorkerModels(run, identity, ledger, artifacts, live) : null;
  } catch { return undefined; }
}
/** Model rows of a Run for `run inspect`; an attempt the caller may not read shows only the requested pin (evidence `denied`). */
export async function describeRunWorkerModels(run: PinnedRun, principal: VerifiedPrincipal, store: SealedLogs, artifacts: WorkerEventArtifacts,
  authorization: DispatchIdentityAuthorization): Promise<readonly TaskWorkerModel[]> {
  const rows: TaskWorkerModel[] = [];
  for (const task of run.execution.tasks) {
    const pinned = readWorkerModelPin(task.profile.parameters);
    if (!pinned) continue;
    const identity = run.bindings.find(binding => binding.identity.taskId === task.taskId)?.identity ?? null;
    let view = viewWorkerModels({ ...pinned, summary: null, evidence: 'none' });
    if (identity) {
      try { await authorization.authorizeIdentity('read-output', identity, principal); }
      catch (error) {
        if (!denied(error)) throw error;
        rows.push(Object.freeze({ ...viewWorkerModels({ ...pinned, summary: null, evidence: 'denied' }), taskId: task.taskId, attemptId: identity.attemptId })); continue;
      }
      view = await describeAttemptWorkerModels(run, identity, store, artifacts) ?? view;
    }
    rows.push(Object.freeze({ ...view, taskId: task.taskId, attemptId: identity?.attemptId ?? null }));
  }
  return Object.freeze(rows);
}
