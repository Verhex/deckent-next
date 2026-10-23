import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bindTaskAcceptance, encodeDeckentJson, type JsonValue } from '#domain/index.js';
import { dispatchRecordSchema } from '#engine/index.js';
import { migrateLedger, recordAcceptanceMetric } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { evaluating, evidence, identity } from '../domain/acceptance-fixture.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-metrics-transaction-')); roots.push(root);
  const path = join(root, 'ledger.db'), db = new DatabaseSync(path);
  // Build the complete current schema through production migrations, including admission evidence.
  migrateLedger(db, 'allow');
  const { run, attempt } = evaluating();
  const dispatch = dispatchRecordSchema.parse({ schemaVersion: 2, owner: 'worker-owner', launch: 'granted',
    profile: { schemaVersion: 1, adapterId: 'test', adapterVersion: 1, parameters: {} },
    request: { protocolVersion: 1, identity, workspace: root, argv: ['fixture-command'] },
    grant: { generation: 1, grantedAt: 1, principal: { id: 'actor', issuer: 'test', subject: 'author' } },
    terminal: { handle: 'handle', exitCode: 0, interrupted: false },
    output: { schemaVersion: 1, scopeId: identity.scopeId, digest: 'a'.repeat(64), byteLength: 10 } });
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(identity.scopeId, identity.runId, run.revision, JSON.stringify(run), '{}');
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(identity.scopeId, identity.attemptId, attempt.revision, JSON.stringify(attempt));
  db.prepare('INSERT INTO dispatches VALUES(?,?,?)').run(identity.scopeId, identity.attemptId, JSON.stringify(dispatch));
  const journal = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }, { now: () => 100, timeoutMs: 1000 }, 'forbid');
  const input = { commandId: 'evaluation', actor: { id: 'actor', issuer: 'test', subject: 'author' }, expectedRevision: run.revision,
    evaluation: bindTaskAcceptance(run, evidence()), dispatch, now: 100, timeoutMs: 1000 };
  return { db, path, run, journal, input };
}
it('the real evaluation transaction writes one metric beside its receipt and preserves bytes on replay and reopen', async () => {
  const f = await fixture();
  try {
    const receipt = await f.journal.commitTaskEvaluation(f.input);
    expect(receipt.snapshot.progress[0]!.phase).toBe('accepted');
    const bytes = f.db.prepare('SELECT record FROM acceptance_metrics').get()?.record;
    expect(JSON.parse(String(bytes)).metric).toMatchObject({ identity: { attemptId: identity.attemptId }, outcome: { kind: 'task', status: 'accepted' }, durationMs: null, cost: null });
    const envelope = JSON.parse(String(bytes));
    expect(envelope.digest).toBe(createHash('sha256').update(encodeDeckentJson(envelope.metric as JsonValue), 'utf8').digest('hex'));
    expect(await f.journal.commitTaskEvaluation(f.input)).toEqual(receipt);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(1);
    recordAcceptanceMetric(f.db, f.input.commandId, receipt.snapshot);
    f.db.close(); const reopened = new DatabaseSync(f.path);
    try { expect(reopened.prepare('SELECT record FROM acceptance_metrics').get()?.record).toBe(bytes); }
    finally { reopened.close(); }
  } finally { f.journal.close(); if (f.db.isOpen) f.db.close(); }
});
it('a metrics write failure rolls back the Run, evaluation observation and producer receipt together', async () => {
  const f = await fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_metric BEFORE INSERT ON acceptance_metrics BEGIN SELECT RAISE(ABORT,'fixture metrics failure'); END;");
    await expect(f.journal.commitTaskEvaluation(f.input)).rejects.toThrow('fixture metrics failure');
    expect(f.db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(JSON.stringify(f.run));
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM run_receipts').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_evaluation_observations').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(0);
  } finally { f.journal.close(); f.db.close(); }
});
it('a receipt failure cannot leave a metric behind', async () => {
  const f = await fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON run_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
    await expect(f.journal.commitTaskEvaluation(f.input)).rejects.toThrow('fixture receipt failure');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT snapshot FROM runs').get()?.snapshot).toBe(JSON.stringify(f.run));
  } finally { f.journal.close(); f.db.close(); }
});
it('metrics without an exact producer receipt and different bytes for the same producer are typed refusals', async () => {
  const f = await fixture();
  try {
    expect(() => recordAcceptanceMetric(f.db, 'missing', f.run)).toThrow('RUN_STORE_CONFLICT');
    const receipt = await f.journal.commitTaskEvaluation(f.input);
    f.db.prepare('UPDATE acceptance_metrics SET record=?').run('{}');
    expect(() => recordAcceptanceMetric(f.db, f.input.commandId, receipt.snapshot)).toThrow('RUN_COMMAND_CONFLICT');
    await expect(f.journal.commitTaskEvaluation({ ...f.input, actor: { ...f.input.actor, subject: 'another' } })).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
  } finally { f.journal.close(); f.db.close(); }
});
it('the producer key allows a new canonical evaluation of the same Attempt after a retained evidence return', async () => {
  const f = await fixture();
  try {
    const unknown = { ...f.input, evaluation: bindTaskAcceptance(f.run, evidence('unknown')) };
    const first = await f.journal.commitTaskEvaluation(unknown);
    const changed = { ...f.input.dispatch, output: { ...f.input.dispatch.output!, digest: 'b'.repeat(64) } };
    f.db.prepare('UPDATE dispatches SET record=?').run(JSON.stringify(changed));
    const next = bindTaskAcceptance(first.snapshot, { ...evidence(), evaluationId: 'new-evidence', evidenceDigests: ['b'.repeat(64)],
      returnEvidence: { kind: 'output', digest: 'b'.repeat(64) } });
    const second = await f.journal.commitTaskEvaluation({ ...f.input, commandId: 'new-evidence', expectedRevision: first.snapshot.revision, evaluation: next, dispatch: changed, now: 200 });
    expect(second.snapshot.progress[0]!.phase).toBe('accepted');
    expect(f.db.prepare('SELECT producer_command_id,superseded_by FROM acceptance_metrics ORDER BY producer_command_id').all()).toEqual([
      { producer_command_id: 'evaluation', superseded_by: 'new-evidence' }, { producer_command_id: 'new-evidence', superseded_by: null }]);
  } finally { f.journal.close(); f.db.close(); }
});

it('a Run incomplete observation is recorded by its lifecycle producer and replays without another row', async () => {
  const f = await fixture();
  try {
    const extraGraph = { ...f.run.graph, tasks: [...f.run.graph.tasks, { ...f.run.graph.tasks[0]!, id: 'unfinished' }] };
    const { execution } = await import('../domain/acceptance-fixture.js');
    const parked = { ...f.run, graph: extraGraph, execution: execution(extraGraph),
      state: { kind: 'parked', reason: 'operator-hold', note: 'fixture hold', since: 1, deadline: 1000 },
      progress: [{ ...f.run.progress[0]!, phase: 'accepted' }, { taskId: 'unfinished', phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } }] };
    f.db.prepare('UPDATE runs SET snapshot=?').run(JSON.stringify(parked));
    const command = { schemaVersion: 1 as const, commandId: 'close-run', scopeId: identity.scopeId, runId: identity.runId, expectedRevision: f.run.revision,
      action: 'close' as const, actor: { ...f.input.actor, assurance: 'os-user' as const }, now: 200, timeoutMs: 1000 };
    // MCP-AI-AKTOR: close is a human step; the journal commits it only with its atomic audit writer (the application supplies it).
    let audited = 0; const closed = await f.journal.commitRunLifecycle(command, () => { audited++; }); expect(audited).toBe(1);
    expect(closed.snapshot.state).toMatchObject({ kind: 'terminal', outcome: 'incomplete' });
    const row = f.db.prepare('SELECT record FROM acceptance_metrics').get();
    expect(JSON.parse(String(row?.record)).metric.outcome).toEqual({ kind: 'run', status: 'incomplete' });
    expect(await f.journal.commitRunLifecycle(command, () => { audited++; })).toEqual(closed); expect(audited).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM acceptance_metrics').get()?.n).toBe(1);
  } finally { f.journal.close(); f.db.close(); }
});

it('a human decision on an awaiting Task writes a human task row that supersedes the system row of its Attempt', async () => {
  const f = await fixture();
  try {
    const first = await f.journal.commitTaskEvaluation({ ...f.input, evaluation: bindTaskAcceptance(f.run, evidence('unknown')) });
    expect(first.snapshot.progress[0]!.phase).toBe('awaiting-decision');
    const command = { schemaVersion: 1 as const, commandId: 'decide', scopeId: identity.scopeId, runId: identity.runId, expectedRevision: first.snapshot.revision,
      action: 'accept' as const, taskId: identity.taskId, actor: { ...f.input.actor, assurance: 'os-user' as const }, now: 200, timeoutMs: 1000 };
    const decided = await f.journal.commitRunLifecycle(command, () => undefined);
    expect(decided.snapshot.progress[0]!.phase).toBe('accepted');
    const rows = f.db.prepare('SELECT producer_command_id,superseded_by,record FROM acceptance_metrics ORDER BY rowid').all();
    expect(rows.map(row => [row.producer_command_id, row.superseded_by])).toEqual([['evaluation', 'decide'], ['decide', null]]);
    expect(JSON.parse(String(rows[1]!.record)).metric).toMatchObject({ schemaVersion: 2, outcome: { kind: 'task', status: 'accepted', decision: 'human' },
      evidenceKinds: ['human-decision', 'unknown'], evidenceReferences: [{ id: 'dispatch-output', digest: 'a'.repeat(64) }] });
    // The read path the cost report and monitor use returns the current (human) row of the Attempt.
    const { readRunAcceptanceMetrics } = await import('#adapters/core/sqlite-ledger/index.js');
    expect(readRunAcceptanceMetrics(f.db, decided.snapshot)[0]).toMatchObject({ outcome: { decision: 'human' } });
  } finally { f.journal.close(); f.db.close(); }
});
