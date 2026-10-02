import { expect, it, vi } from 'vitest';
import { RunLifecycleApplication, PolicyAuthorizationError } from '#engine/index.js';
const principal = { id: 'human', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const command = { schemaVersion: 1, commandId: 'decision', scopeId: 's', runId: 'r', expectedRevision: 2, action: 'accept', taskId: 't' };
function fixture(assurance: string, now = 100) {
  const store = { loadRun: vi.fn(), commitRunLifecycle: vi.fn(), hasTaskEvaluation: vi.fn() }, run = { authorize: vi.fn() }, task = { authorize: vi.fn() };
  const app = new RunLifecycleApplication(store as never, { async verify() { return { ...principal, assurance }; } } as never,
    run, task, () => ({ record: vi.fn() }), () => now, 1000, 'policy');
  return { app, store, run, task };
}
it.each(['workload-verified', 'token-verified'])('refuses %s decision before reading or writing durable state', async assurance => {
  const f = fixture(assurance);
  await expect(f.app.execute(command)).rejects.toThrow('TASK_DECISION_HUMAN_REQUIRED');
  expect(f.store.loadRun).not.toHaveBeenCalled(); expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
});
it('refuses caller-authored actor, timeout or decision evidence', async () => {
  for (const extra of [{ actor: principal }, { timeoutMs: 0 }, { evidence: 'verified' }]) {
    const f = fixture('os-user'); await expect(f.app.execute({ ...command, ...extra })).rejects.toThrow();
    expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
  }
});

import { createRun, parkTaskAwaitingDecision, resolveTaskDecision, type RunSnapshot } from '#domain/index.js';
import { AuditApplication, RunLifecycleRuntimeLoop } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'test', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'exit', version: 1 }, parameters: {} }] };
const identity = { runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
function waiting(independent = false) {
  const selectedGraph = independent ? { ...graph, tasks: [...graph.tasks, { ...graph.tasks[0], id: 'other' }] } : graph;
  const base = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, selectedGraph, 0, fixtureExecution(selectedGraph));
  return parkTaskAwaitingDecision({ ...base, revision: 1, progress: base.progress.map(task => task.taskId === 't' ? { ...task, phase: 'evaluating' } : task),
    bindings: [{ identity, observedKind: 'exited', observedRevision: 1 }] }, 1, 't', 'evaluation-unknown', 10, 1000);
}
it('authorizes attempt:evaluate for the exact binding and records a typed principal audit with the human decision', async () => {
  const run = waiting(), audits: unknown[] = [], authorization = { authorize: vi.fn() };
  const store = { async loadRun() { return run; }, async commitRunLifecycle(write: import('#engine/index.js').RunLifecycleWrite, audit: (store: never, snapshot: RunSnapshot) => void) {
    const snapshot = resolveTaskDecision(run, write.expectedRevision, write.taskId!, write.action as 'accept', write.now, write.timeoutMs);
    audit({} as never, snapshot); return { commandId: write.commandId, command: JSON.stringify(write), snapshot };
  } };
  const integrity = createHmacIntegrity('audit', new Uint8Array(32).fill(1));
  const records = { append(_event: unknown, seal: (sequence: number) => unknown) { const record = seal(1); audits.push(record); return record; } };
  const app = new RunLifecycleApplication(store as never, { async verify() { return principal; } }, { authorize: vi.fn() }, authorization,
    () => ({ record(event: unknown) { audits.push(event); return new AuditApplication(records as never, integrity).record(event); } }), () => 100, 1000, 'policy');
  const result = await app.execute(command);
  expect(authorization.authorize).toHaveBeenCalledWith(identity, principal);
  expect(result.snapshot.progress[0].acceptedEvidence).toBe('model-unverified');
  expect(audits[0]).toMatchObject({ principal: { issuer: 'host', subject: '1000' }, policyRevision: 'policy', subject: { kind: 'run-lifecycle', action: 'accept', evidence: 'model-unverified' } });
});
it('a denied attempt decision never writes or records an acceptance', async () => {
  const f = fixture('os-user'); f.store.loadRun.mockResolvedValue(waiting());
  f.task.authorize.mockRejectedValue(new Error('POLICY_DENIED'));
  await expect(f.app.execute(command)).rejects.toThrow('POLICY_DENIED'); expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
});
it('reads no-due maintenance with inspect alone and writes nothing', async () => {
  const f = fixture('workload-verified');
  f.store.loadRun.mockResolvedValue(waiting());
  f.run.authorize.mockImplementation(async action => { if (action !== 'inspect') throw new PolicyAuthorizationError('POLICY_DENIED'); });
  const query = { schemaVersion: 1, scopeId: 's', runId: 'r' };
  expect(await f.app.advance(query)).toBeNull();
  expect(f.run.authorize.mock.calls.map(([action]) => action)).toEqual(['inspect']);
  expect(f.store.loadRun).toHaveBeenCalledWith('s', 'r');
  expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
});
it.each([false, true])('refuses due expiry with a typed cancellation denial after inspect, without writing (independent task=%s)', async independent => {
  const f = fixture('workload-verified', 1100);
  f.store.loadRun.mockResolvedValue(waiting(independent));
  f.run.authorize.mockImplementation(async action => { if (action !== 'inspect') throw new PolicyAuthorizationError('POLICY_DENIED'); });
  await expect(f.app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.run.authorize.mock.calls.map(([action]) => action)).toEqual(['inspect', 'cancel']);
  expect(f.store.loadRun).toHaveBeenCalledWith('s', 'r');
  expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
});
it('refuses inspect before loading any maintenance state', async () => {
  const f = fixture('workload-verified'); f.run.authorize.mockRejectedValue(new PolicyAuthorizationError('POLICY_DENIED'));
  await expect(f.app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.store.loadRun).not.toHaveBeenCalled(); expect(f.store.commitRunLifecycle).not.toHaveBeenCalled();
});
it('authorizes maintenance expiry using the same cancellation grant as operator close', async () => {
  const f = fixture('workload-verified', 1100), run = waiting();
  f.store.loadRun.mockResolvedValue(run);
  f.store.commitRunLifecycle.mockResolvedValue({ snapshot: run });
  await f.app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect(f.run.authorize).toHaveBeenCalledWith('cancel', { schemaVersion: 1, scopeId: 's', runId: 'r' }, expect.objectContaining({ assurance: 'workload-verified' }));
  expect(f.store.commitRunLifecycle).toHaveBeenCalledWith(expect.objectContaining({ action: 'expire', expectedRevision: run.revision,
    actor: expect.objectContaining({ assurance: 'workload-verified' }) }));
});
it('deadline pages advance their own cursor and one refused Run does not prevent another expiry or ready Run', async () => {
  const controller = new AbortController(), seen: unknown[] = [], expired: string[] = [], advanced: string[] = [];
  const denied = fixture('workload-verified', 1100), errors: unknown[] = [];
  denied.store.loadRun.mockResolvedValue(waiting());
  denied.run.authorize.mockImplementation(async action => { if (action !== 'inspect') throw new PolicyAuthorizationError('POLICY_DENIED'); });
  let turn = 0;
  const loop = new RunLifecycleRuntimeLoop({
    async discover(after, dueAfter, now) {
      seen.push({ after, dueAfter, now }); turn++;
      return { page: { items: [{ scopeId: 's', runId: 'ready' }], next: null },
        due: { items: turn === 1 ? [{ scopeId: 's', runId: 'denied' }, { scopeId: 's', runId: 'due' }] : [], next: turn === 1 ? { scopeId: 's', runId: 'due' } : null } };
    },
    async expire(query) { expired.push(query.runId); if (query.runId === 'denied') await denied.app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' }); },
    async advance(query) { advanced.push(query.runId); if (turn === 2) controller.abort(); return {} as never; },
  }, { onError(query, error) { errors.push({ query, error }); } }, { pollIntervalMs: 1, failureBackoffMs: 1 }, () => 1100);
  await loop.run(controller.signal);
  expect(errors).toEqual([{ query: { scopeId: 's', runId: 'denied' }, error: expect.objectContaining({ code: 'POLICY_DENIED' }) }]);
  expect(denied.store.commitRunLifecycle).not.toHaveBeenCalled();
  expect(expired).toEqual(['denied', 'due']); expect(advanced).toEqual(['ready', 'ready']);
  expect(seen[1]).toEqual({ after: null, dueAfter: { scopeId: 's', runId: 'due' }, now: 1100 });
});

it('parks recorded legacy unknowns with attempt evaluation authority without requiring cancel', async () => {
  const f = fixture('workload-verified'), parked = waiting();
  const run = { ...parked, state: { kind: 'running' }, progress: parked.progress.map(task => ({ ...task, phase: 'evaluating', decision: undefined })) };
  f.store.loadRun.mockResolvedValue(run); f.store.hasTaskEvaluation.mockResolvedValue(true);
  f.store.commitRunLifecycle.mockResolvedValue({ snapshot: parked });
  f.run.authorize.mockImplementation(async action => { if (action !== 'inspect') throw new PolicyAuthorizationError('POLICY_DENIED'); });
  await f.app.advance({ schemaVersion: 1, scopeId: 's', runId: 'r' });
  expect(f.task.authorize).toHaveBeenCalledWith(identity, expect.objectContaining({ assurance: 'workload-verified' }));
  expect(f.run.authorize.mock.calls.map(([action]) => action)).toEqual(['inspect']);
  expect(f.store.commitRunLifecycle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'park-task', taskId: 't' }));
});
