import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyAttemptObservation, applyTaskEvaluation, createAttempt, createRun, deriveDeckentMetrics,
  observeRunAttempt, reserveRunTasks, type TaskEvaluation } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
const graph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 'task', kind: 'custom', dependencies: [], acceptanceCriteria: ['criterion'] }],
  criterionDefinitions: [{ id: 'criterion', version: 1, description: 'Verify durable business evidence',
    evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };

/** Executable counterexample for the CARD's proposed immutable key, not a production metrics writer. */
it.each(['pass', 'unknown'] as const)('the card metrics key collides with a valid same-Attempt evidence return (%s)', verdict => {
  const runIdentity = { scopeId: identity.scopeId, runId: identity.runId, layoutRevision: identity.layoutRevision };
  const reserved = reserveRunTasks(createRun(runIdentity, graph, 0, fixtureExecution(graph)), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1,
    eventId: 'exit', result: { kind: 'exited', exitCode: 0 } }, 0);
  const run = observeRunAttempt(reserved, 1, attempt);
  const firstDigest = 'a'.repeat(64), nextDigest = 'b'.repeat(64);
  const firstEvidence: TaskEvaluation = { schemaVersion: 1, evaluationId: 'first', identity, graphRevision: 1,
    attemptRevision: 1, criteria: [{ criterionId: 'criterion', verdict: 'unknown', evidenceIds: [] }], evidenceDigests: [firstDigest] };
  const first = applyTaskEvaluation(run, run.revision, firstEvidence, { now: 100, timeoutMs: 1000 });
  const nextEvidence: TaskEvaluation = { ...firstEvidence, evaluationId: 'new-evidence',
    criteria: [{ criterionId: 'criterion', verdict, evidenceIds: ['output'] }],
    evidenceDigests: [firstDigest, nextDigest], returnEvidence: { kind: 'output', digest: nextDigest } };
  const next = applyTaskEvaluation(first.snapshot, first.snapshot.revision, nextEvidence, { now: 200, timeoutMs: 1000 });
  expect(next.snapshot.bindings).toEqual(first.snapshot.bindings);
  expect(next.snapshot.progress[0]!.phase).toBe(verdict === 'pass' ? 'accepted' : 'awaiting-decision');
  const metric = (status: 'accepted' | 'awaiting-decision', digest: string) => deriveDeckentMetrics({
    identity: { scopeId: identity.scopeId, runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId },
    workClass: null, policyRevision: null, profileVersion: null, skillSetDigest: null, model: null,
    outcome: { kind: 'task', status, decision: 'system' }, attemptSequence: 1, effort: null, actualModel: null, evidenceKinds: [], acceptanceScore: null,
    evidenceReferences: [{ id: 'output', digest }] });
  const firstRow = metric('awaiting-decision', firstDigest), nextRow = metric(verdict === 'pass' ? 'accepted' : 'awaiting-decision', nextDigest);
  expect(JSON.stringify(nextRow)).not.toBe(JSON.stringify(firstRow));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE candidate_metrics(scope_id TEXT, run_id TEXT, task_id TEXT, attempt_id TEXT, outcome_kind TEXT, record TEXT,
      PRIMARY KEY(scope_id, run_id, task_id, attempt_id, outcome_kind));`);
    const insert = db.prepare('INSERT INTO candidate_metrics VALUES(?,?,?,?,?,?)');
    insert.run(identity.scopeId, identity.runId, identity.taskId, identity.attemptId, 'task', JSON.stringify(firstRow));
    expect(() => insert.run(identity.scopeId, identity.runId, identity.taskId, identity.attemptId, 'task', JSON.stringify(nextRow)))
      .toThrow(/UNIQUE constraint failed/);
    expect(db.prepare('SELECT record FROM candidate_metrics').get()?.record).toBe(JSON.stringify(firstRow));
  } finally { db.close(); }
});
