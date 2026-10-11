import { expect, it } from 'vitest';
import { createAttempt, createRun, type RunSnapshot } from '#domain/index.js';
import { handoffEventCommandId, handoffReceiptViewSchema, handoffStartRecordSchema, projectTaskHandoffs,
  projectRunView, projectMonitorRun, readAttemptHandoffEvents, RunInspectionApplication, type HandoffStartRecord } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const identity = (taskId: string) => ({ scopeId: 's', runId: 'r', layoutRevision: 'l', taskId, attemptId: `attempt-${taskId}`, generation: 1 });
const graph = { schemaVersion: 4 as const, revision: 1, tasks: [
  { id: 'a', kind: 'coding', dependencies: [], acceptanceCriteria: ['ok'] },
  { id: 'b', kind: 'coding', dependencies: [{ taskId: 'a', startFrom: 'accepted-patch' as const }], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
const base = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
const run = { ...base, progress: base.progress.map(task => ({ ...task, phase: task.taskId === 'a' ? 'accepted' : 'active' })),
  bindings: ['a', 'b'].map(task => ({ identity: identity(task), observedRevision: null, observedKind: null })) } as RunSnapshot;
const note = { kind: 'handoff-received' as const, source: identity('a'), digest: 'a'.repeat(64) };
const patch = { ...note, kind: 'workspace-started-from-patch' as const, digest: 'b'.repeat(64) };
const record: HandoffStartRecord = { schemaVersion: 1, identity: identity('b'), events: [note, patch] };

it('keeps note and patch receipts separate in Run and monitor, without inventing a starting snapshot', () => {
  const before = JSON.stringify(record);
  expect(projectTaskHandoffs(run, 'b', [record])).toEqual([note, patch]);
  expect(projectRunView(run, [record]).tasks[1]?.handoffs).toEqual([note, patch]);
  const attempt = { attemptId: 'attempt-b', generation: 1, observedKind: null, observedRevision: null, dispatch: null,
    evaluationObserved: false, reservedAtMs: null, sealedAtMs: null, handoffStart: record };
  expect(projectMonitorRun({ run: { snapshot: run, poolId: null, admitted: true, createdAtMs: null, attempts: [attempt] },
    approvals: [], pool: null, workers: new Map(), observedAt: 10 }).tasks[1]?.handoffs).toEqual([note, patch]);
  expect(projectTaskHandoffs(run, 'b', [record])[1]).not.toHaveProperty('snapshotDigest');
  expect(JSON.stringify(record)).toBe(before);
});

it('projects an authenticated immutable journal receipt through public inspection without any storage write', async () => {
  const command = JSON.stringify(record), snapshot = createAttempt(record.identity);
  const app = new RunInspectionApplication({ async loadRun() { return run; },
    async receipt(scopeId, commandId) {
      expect(scopeId).toBe('s');
      return commandId === handoffEventCommandId(record.identity) ? { command, snapshot } : null;
    } }, { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] }; } },
  { async authorize() {} });
  expect((await app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' }))?.tasks[1]?.handoffs).toEqual([note, patch]);
  expect(JSON.stringify(snapshot)).toBe(JSON.stringify(createAttempt(record.identity)));
  expect(JSON.stringify(record)).toBe(command);
});

it('a dependency and acceptance alone never prove a handoff or patch start', () => {
  expect(projectTaskHandoffs(run, 'b', [])).toEqual([]);
  expect(projectTaskHandoffs(run, 'b', [{ ...record, events: [] }])).toEqual([]);
  expect(projectTaskHandoffs(run, 'missing', [record])).toEqual([]);
  expect(projectTaskHandoffs({ ...run, bindings: [] }, 'b', [record])).toEqual([]);
});

it.each(['failed', 'skipped', 'awaiting-decision', 'active', 'evaluating', 'pending', 'cancelled', 'reconciling'] as const)(
  'withholds both event kinds from a %s source', phase => {
    const changed = { ...run, progress: run.progress.map(task => task.taskId === 'a' ? { ...task, phase } : task) };
    expect(projectTaskHandoffs(changed, 'b', [record])).toEqual([]);
  });

it.each(['scopeId', 'runId', 'layoutRevision', 'taskId', 'attemptId', 'generation'] as const)(
  'withholds both event kinds when source %s differs from its accepted binding', field => {
    const source = { ...identity('a'), [field]: field === 'generation' ? 2 : 'foreign' };
    expect(projectTaskHandoffs(run, 'b', [{ ...record, events: [{ ...note, source }, { ...patch, source }] }])).toEqual([]);
  });

it.each(['scopeId', 'runId', 'layoutRevision', 'taskId', 'attemptId', 'generation'] as const)(
  'withholds both event kinds when receiving %s differs from its current binding', field => {
    const changed = { ...record.identity, [field]: field === 'generation' ? 2 : 'foreign' };
    expect(projectTaskHandoffs(run, 'b', [{ ...record, identity: changed }])).toEqual([]);
  });

it('withholds a source without a binding or a direct dependency', () => {
  expect(projectTaskHandoffs({ ...run, bindings: run.bindings.filter(value => value.identity.taskId !== 'a') }, 'b', [record])).toEqual([]);
  const changed = { ...run, graph: { ...run.graph, tasks: run.graph.tasks.map(task => task.id === 'b' ? { ...task, dependencies: [] } : task) } };
  expect(projectTaskHandoffs(changed, 'b', [record])).toEqual([]);
});

it.each(['string', 'object'] as const)('fixed-base %s dependency retains the note but cannot prove patch-based start', form => {
  const changed = { ...run, graph: { ...run.graph, tasks: run.graph.tasks.map(task => task.id === 'b'
    ? { ...task, dependencies: form === 'string' ? ['a'] : [{ taskId: 'a' }] } : task) } };
  expect(projectTaskHandoffs(changed, 'b', [record])).toEqual([note]);
});

it('replayed receipts deduplicate each source and kind without losing either digest', () => {
  expect(projectTaskHandoffs(run, 'b', [record, record])).toEqual([note, patch]);
  expect(projectTaskHandoffs(run, 'b', [{ ...record, events: [patch, note] }])).toEqual([patch, note]);
  expect(Object.isFrozen(projectTaskHandoffs(run, 'b', [record]))).toBe(true);
});

it('reads legacy journal bytes and views unchanged without backfill or a fabricated starting snapshot', async () => {
  // The existing journal writer serializes schema-parsed identities in canonical schema key order.
  const command = JSON.stringify(handoffStartRecordSchema.parse(record));
  expect(JSON.stringify(handoffStartRecordSchema.parse(JSON.parse(command)))).toBe(command);
  const legacyView = { source: note.source, digest: note.digest };
  expect(handoffReceiptViewSchema.parse(legacyView)).toEqual(legacyView);
  expect(await readAttemptHandoffEvents({ async receipt() { return { command, snapshot: createAttempt(record.identity) }; } }, record.identity)).toEqual(record);
});

it('rejects malformed observation kinds and digests rather than accepting arbitrary worker text', () => {
  expect(handoffReceiptViewSchema.safeParse({ ...patch, kind: 'worker-reported-start' }).success).toBe(false);
  expect(handoffReceiptViewSchema.safeParse({ ...patch, digest: 'bad' }).success).toBe(false);
  expect(handoffReceiptViewSchema.safeParse({ ...patch, snapshotDigest: patch.digest }).success).toBe(false);
});
